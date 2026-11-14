// German grammar analysis in the browser: dictionary lookups plus hand-written rules.
//
// Pipeline for one sentence (or translation unit):
//   1. tokenise, split into clauses
//   2. collect dictionary readings for every word (exact form, other capitalisation,
//      adjective endings, elided endings, joined separable verbs, unknown compounds)
//   3. choose one reading per word from context
//   4. per clause: find the finite verb, link detached prefixes of separable verbs,
//      recognise compound tenses and the passive
//   5. resolve case, number and gender of noun phrases from articles and prepositions
//   6. optionally refine everything with a dependency parse from the local service
//   7. build the structured result
//
// Everything that rests on a heuristic is marked `likely` or `uncertain`; the engine never
// presents a guess as a fact.
import { capitalize, decapitalize, isCapitalized, tokenize } from '../shared/text.ts';
import type {
  AdjectiveAnalysis,
  AdjectiveDegree,
  AlternativeReading,
  Auxiliary,
  Certainty,
  Gender,
  GrammarFeature,
  GrammaticalCase,
  GrammaticalNumber,
  InfoSource,
  Marked,
  Mood,
  NounAnalysis,
  OtherAnalysis,
  PartOfSpeech,
  Person,
  PresentConjugation,
  SeparableInfo,
  Tense,
  Token,
  VerbAnalysis,
  VerbFormKind,
  Voice,
  WordAnalysis,
} from '../shared/types';
import {
  AUXILIARIES,
  COPULAS,
  DATIVE_VERBS,
  INSEPARABLE_PREFIXES,
  MODALS,
  MOTION_VERBS,
  SEPARABLE_PREFIXES,
  SEPARABLE_SET,
  SOFT_BOUNDARIES,
  SUBORDINATORS,
  determinerInfo,
  functionWordInfo,
  prepositionInfo,
  pronounInfo,
  type DeterminerInfo,
  type FunctionWordInfo,
  type Genus,
  type PrepositionInfo,
  type PronounInfo,
  type Slot,
} from './closed-class.ts';
import type { DictEntry, Dictionary, PosCode } from './dictionary';
import { equivalents, pickSense } from './senses.ts';

/** Part of the analysis cache key: bump when the output for the same input may change. */
export const ANALYZER_VERSION = 4;

/** Token of a dependency parse (spaCy), as delivered by the local service. */
export interface ParseToken {
  start: number;
  end: number;
  lemma: string;
  /** Universal POS tag. */
  pos: string;
  morph: Record<string, string>;
  dep: string;
  /** Index of the head token in the parse. */
  head: number;
}

export interface AnalyzeOptions {
  /** Russian translation of the sentence; used to choose the fitting dictionary sense. */
  translation?: string;
  parse?: ParseToken[];
}

type Via = 'exact' | 'case' | 'ending' | 'elided' | 'joined' | 'compound';

interface Reading {
  id: number;
  entry: DictEntry;
  codes: string[];
  via: Via;
  /** Adjective ending that was removed to find the entry. */
  ending?: string;
  parts?: string[];
  score: number;
}

type Kind = 'det' | 'prep' | 'pron' | 'func' | 'noun' | 'verb' | 'adj' | 'other' | 'unknown';

interface VerbState {
  entry: DictEntry;
  codes: string[];
  role: 'main' | 'auxiliary' | 'modal' | 'prefix';
  kind: VerbFormKind;
  tense?: Marked<Tense>;
  mood?: Marked<Mood>;
  voice?: Marked<Voice>;
  person?: Marked<Person[]>;
  number?: Marked<GrammaticalNumber>;
  sep?: SeparableInfo;
  note?: string;
}

interface NpState {
  cases: GrammaticalCase[];
  number?: GrammaticalNumber;
  gender?: Gender[];
  certainty: Certainty;
}

interface Word {
  i: number;
  text: string;
  lower: string;
  cap: boolean;
  /** First word of a sentence: its capital letter carries no information. */
  start: boolean;
  det: DeterminerInfo | null;
  prep: PrepositionInfo | null;
  pron: PronounInfo | null;
  func: FunctionWordInfo | null;
  readings: Reading[];
  chosen: Reading | null;
  kind: Kind;
  clause: number;
  hard: number;
  /** Last word before a clause boundary. */
  last: boolean;
  verb?: VerbState;
  np?: NpState;
  /** Index (in the word list) of the noun this determiner, adjective or preposition belongs to. */
  head?: number;
  parse?: ParseToken;
}

const CASE_ORDER: GrammaticalCase[] = ['nominative', 'genitive', 'dative', 'accusative'];
const POS_OF: Record<PosCode, PartOfSpeech> = {
  n: 'noun',
  name: 'proper-noun',
  v: 'verb',
  a: 'adjective',
  adv: 'adverb',
  prep: 'preposition',
  conj: 'conjunction',
  pron: 'pronoun',
  det: 'determiner',
  num: 'numeral',
  part: 'particle',
  intj: 'interjection',
};
const UPOS: Record<string, PosCode[]> = {
  NOUN: ['n'],
  PROPN: ['name', 'n'],
  VERB: ['v'],
  AUX: ['v'],
  ADJ: ['a'],
  ADV: ['adv', 'a'],
  ADP: ['prep'],
  DET: ['det'],
  PRON: ['pron'],
  CCONJ: ['conj'],
  SCONJ: ['conj'],
  NUM: ['num'],
  PART: ['part'],
  INTJ: ['intj'],
};

const mark = <T>(value: T, certainty: Certainty = 'certain', source: InfoSource = 'dictionary'): Marked<T> => ({ value, certainty, source });
const isNounEntry = (e: DictEntry): boolean => e.p === 'n' || e.p === 'name';
const isFinite = (code: string): boolean => /^(ip|it|k1|k2)\d[sp]$/.test(code) || code === 'ms' || code === 'mp';
const isAdjCode = (code: string): boolean => /^[aA]\d$/.test(code);
const HARD_PUNCT = new Set([',', ';', ':', '.', '!', '?', '…', '–', '—', '(', ')']);
const SENTENCE_END = new Set(['.', '!', '?', '…', ':']);
const ADJ_ENDINGS = ['em', 'en', 'er', 'es', 'e'];

// ───────────────────────── 1–2. tokens and readings ─────────────────────────

async function collectReadings(word: Word, dict: Dictionary): Promise<Reading[]> {
  const out: Reading[] = [];
  const seen = new Set<string>();
  const add = async (form: string, via: Via, filter?: (codes: string[]) => string[], extra: Partial<Reading> = {}): Promise<void> => {
    for (const hit of await dict.lookup(form)) {
      const codes = filter ? filter(hit.codes) : hit.codes;
      if (codes.length === 0) continue;
      const key = `${hit.id}|${via === 'ending' ? `e${extra.ending}` : ''}`;
      if (seen.has(key)) continue;
      const entry = await dict.entry(hit.id);
      if (!entry) continue;
      seen.add(key);
      out.push({ id: hit.id, entry, codes, via, score: 0, ...extra });
    }
  };

  // Stems of declined adjectives are index keys too ("hoh" for "hohe"); they are not words.
  const wholeWord = (codes: string[]): string[] => codes.filter((c) => !/^a\d$/.test(c));
  const base = word.text.replace(/['’]$/, '');
  await add(base, 'exact', wholeWord);
  if (word.cap) await add(decapitalize(base), 'case', wholeWord);
  else if (out.length === 0) await add(capitalize(base), 'case', wholeWord);

  // Declined adjectives and participles: stem + ending.
  for (const ending of ADJ_ENDINGS) {
    if (!word.lower.endsWith(ending) || word.lower.length - ending.length < 2) continue;
    await add(word.lower.slice(0, -ending.length), 'ending', (codes) => codes.filter((c) => isAdjCode(c) || c === 'p1' || c === 'p2'), { ending });
  }

  // Colloquial first person without -e: "ich hab", "ich komm'".
  const hasIndicative = out.some((r) => r.entry.p === 'v' && r.codes.some((c) => c.startsWith('ip') || c.startsWith('it')));
  if (!hasIndicative && !word.cap) await add(`${word.lower.replace(/['’]$/, '')}e`, 'elided', (codes) => codes.filter((c) => c === 'ip1s'));

  // Joined form of a separable verb that the index does not list: prefix + form of the base verb.
  if (!out.some((r) => r.entry.p === 'v') && word.lower.length >= 6) {
    for (const prefix of SEPARABLE_PREFIXES) {
      if (!word.lower.startsWith(prefix)) continue;
      const rest = word.lower.slice(prefix.length);
      const candidates: [string, boolean][] = [[rest, false]];
      if (rest.startsWith('zu') && rest.length > 5) candidates.push([rest.slice(2), true]);
      for (const [form, zu] of candidates) {
        if (form.length < 3) continue;
        for (const hit of await dict.lookup(form)) {
          const baseEntry = await dict.entry(hit.id);
          if (!baseEntry || baseEntry.p !== 'v') continue;
          const codes = zu ? (hit.codes.includes('inf') ? ['zu'] : []) : hit.codes.filter((c) => isFinite(c) || c === 'p2' || c === 'inf');
          if (codes.length === 0) continue;
          for (const lemmaHit of await dict.lookup(prefix + baseEntry.w)) {
            const entry = await dict.entry(lemmaHit.id);
            if (!entry || entry.p !== 'v' || !lemmaHit.codes.includes('inf') || seen.has(`${lemmaHit.id}|`)) continue;
            seen.add(`${lemmaHit.id}|`);
            out.push({ id: lemmaHit.id, entry, codes, via: 'joined', score: 0 });
          }
        }
      }
      if (out.some((r) => r.via === 'joined')) break;
    }
  }

  // Unknown capitalised word: try to read it as a compound noun, "Haustür|schlüssel".
  if (out.length === 0 && word.cap && word.text.length >= 7 && !word.text.includes('-')) {
    const compound = await splitCompound(word.text, dict);
    if (compound) out.push(compound);
  }
  return out;
}

async function splitCompound(text: string, dict: Dictionary): Promise<Reading | null> {
  const known = async (form: string): Promise<boolean> => (await dict.lookup(form)).length > 0;
  for (let i = 3; i <= text.length - 3; i++) {
    const left = text.slice(0, i);
    const right = capitalize(text.slice(i));
    const head = (await dict.lookup(right)).find((h) => h.codes.some((c) => c.startsWith('N')));
    if (!head) continue;
    const headEntry = await dict.entry(head.id);
    if (!headEntry || headEntry.p !== 'n') continue;
    // The first part may carry a linking element: Arbeit-s-zeit, Sonne-n-schein.
    let first: string | null = null;
    for (const cut of ['', 's', 'es', 'n', 'en', 'e']) {
      if (cut && !left.endsWith(cut)) continue;
      const stem = cut ? left.slice(0, -cut.length) : left;
      if (stem.length >= 3 && ((await known(stem)) || (await known(decapitalize(stem))) || (await known(`${decapitalize(stem)}en`)))) {
        first = stem;
        break;
      }
    }
    if (!first) continue;
    const join = (form: string): string => left + form.toLowerCase();
    const lemma = join(headEntry.w);
    const entry: DictEntry = {
      w: lemma,
      p: 'n',
      g: headEntry.g,
      gs: headEntry.gs?.map(join),
      pl: headEntry.pl?.map(join),
      ru: headEntry.ru,
      mt: headEntry.mt,
    };
    return { id: 1_000_000 + head.id, entry, codes: head.codes, via: 'compound', parts: [first, headEntry.w], score: 0 };
  }
  return null;
}

async function prepare(tokens: Token[], dict: Dictionary): Promise<Word[]> {
  const words: Word[] = [];
  let start = true;
  let clause = 0;
  let hard = 0;
  for (const token of tokens) {
    if (token.kind === 'punct') {
      if (HARD_PUNCT.has(token.text)) {
        clause++;
        hard++;
        const prev = words[words.length - 1];
        if (prev) prev.last = true;
      }
      if (SENTENCE_END.has(token.text)) start = true;
      continue;
    }
    if (token.kind !== 'word') {
      start = false;
      continue;
    }
    const lower = token.text.toLowerCase();
    if (SOFT_BOUNDARIES.has(lower) && words.length > 0) {
      const prev = words[words.length - 1]!;
      if (prev.clause === clause) prev.last = true;
      clause++;
    }
    const word: Word = {
      i: token.index,
      text: token.text,
      lower,
      cap: isCapitalized(token.text),
      start,
      det: determinerInfo(token.text),
      prep: prepositionInfo(token.text),
      pron: pronounInfo(token.text, start),
      func: functionWordInfo(token.text),
      readings: [],
      chosen: null,
      kind: 'unknown',
      clause,
      hard,
      last: false,
    };
    words.push(word);
    start = false;
  }
  const lastWord = words[words.length - 1];
  if (lastWord) lastWord.last = true;
  await Promise.all(
    words.map(async (w) => {
      w.readings = await collectReadings(w, dict);
    }),
  );
  return words;
}

function attachParse(words: Word[], tokens: Token[], parse: ParseToken[] | undefined): void {
  if (!parse) return;
  const byStart = new Map(parse.map((p) => [p.start, p]));
  for (const w of words) {
    const token = tokens[w.i];
    if (token) w.parse = byStart.get(token.start);
  }
}

// ───────────────────────── 3. choosing readings ─────────────────────────

const adjectiveLike = (w: Word | undefined): boolean => Boolean(w && w.readings.some((r) => r.via === 'ending'));
const numeralLike = (w: Word | undefined): boolean => Boolean(w && w.readings.some((r) => r.entry.p === 'num'));
const nounLike = (w: Word | undefined): boolean => Boolean(w && w.cap && (w.readings.some((r) => isNounEntry(r.entry)) || w.readings.length === 0));

/** Index of the noun that heads a phrase starting right after position k, or -1. */
function nounAhead(words: Word[], k: number): number {
  const clause = words[k]?.clause;
  for (let j = k + 1; j < words.length && j <= k + 4; j++) {
    const w = words[j]!;
    if (w.clause !== clause) return -1;
    if (nounLike(w) && !w.start) return j;
    if (!adjectiveLike(w) && !numeralLike(w) && !['sehr', 'ganz', 'so', 'zu', 'ziemlich', 'wirklich', 'besonders'].includes(w.lower)) return -1;
  }
  return -1;
}

function scoreReading(words: Word[], k: number, r: Reading, clauseHasFinite: boolean): number {
  const w = words[k]!;
  const prev = words[k - 1];
  const p = r.entry.p;
  let s = -Math.log10(r.id + 20);
  if (r.via === 'case') s -= 0.4;
  else if (r.via === 'ending') s -= 0.3;
  else if (r.via === 'elided') s -= 1.5;
  else if (r.via === 'joined') s -= 0.5;
  else if (r.via === 'compound') s -= 2;

  const afterDeterminer = Boolean(prev && prev.clause === w.clause && (prev.kind === 'det' || prev.prep?.contraction || (prev.kind === 'adj' && prev.head !== undefined)));
  // Entries with a Russian meaning are the curated ones; bare homonyms rank lower.
  if (!r.entry.ru) s -= 0.6;
  if (p === 'num') s += 1.5;
  if (isNounEntry(r.entry)) {
    if (!w.cap) s -= 6;
    else if (!w.start) s += 3;
    if (afterDeterminer && w.cap) s += 2;
    if (!isCapitalized(r.entry.w)) s -= 3;
    if (r.entry.w === w.text) s += 0.5;
    // "das Essen" cannot be the plural of "die Esse": the article has to fit the reading.
    const det = words.find((x, j) => j < k && x.kind === 'det' && x.head === k && x.det !== null);
    if (det?.det) {
      const genders = gendersOf(r.entry);
      const slots = nounSlots(r);
      const fits = slots.some((slot) => det.det!.slots.some((d) => d.c === slot.c && (slot.n === 'plural' ? d.g === 'pl' : d.g !== 'pl' && (genders.length === 0 || genders.includes(d.g)))));
      s += fits ? 1.5 : -2.5;
    }
  } else {
    if (w.cap && !w.start) s -= 3;
    if (afterDeterminer && p === 'v' && r.via !== 'ending') s -= 3;
    if (p === 'v' && r.via !== 'ending') {
      if (r.codes.every((c) => c === 'ms' || c === 'mp')) s += w.start || !prev || prev.clause !== w.clause ? 0.3 : -3;
      if (r.codes.every((c) => c.startsWith('k1'))) s -= 1;
      if (prev?.lower === 'zu' && r.codes.includes('inf')) s += 3;
      // A clause has one finite verb: "Die Wand ist weiß" is not "… ist (er) weiß".
      if (clauseHasFinite && r.codes.every(isFinite)) s -= 2.5;
    }
    if (r.via === 'ending') s += nounAhead(words, k) >= 0 || nounLike(words[k + 1]) ? 2 : -1.5;
  }
  if (w.parse) {
    const wanted = UPOS[w.parse.pos];
    if (wanted?.includes(p)) s += 4;
    if (w.parse.lemma && w.parse.lemma.toLowerCase() === r.entry.w.toLowerCase()) s += 1;
  }
  return s;
}

function classify(words: Word[]): void {
  const clausesWithFinite = new Set<number>();
  words.forEach((w, k) => {
    const next = words[k + 1];
    const sameClauseNext = next && next.clause === w.clause ? next : undefined;
    const parsePos = w.parse?.pos;
    const head = nounAhead(words, k);

    // Articles and article words need a noun phrase after them; otherwise they are pronouns.
    if (w.det && parsePos !== 'PRON' && (head >= 0 || parsePos === 'DET')) {
      w.kind = 'det';
      if (head >= 0) w.head = head;
      return;
    }
    if (w.prep && w.parse?.dep !== 'svp') {
      const startsPhrase =
        head >= 0 ||
        (sameClauseNext !== undefined &&
          (determinerInfo(sameClauseNext.text) !== null ||
            (pronounInfo(sameClauseNext.text, false)?.cases.some((c) => c !== 'nominative') ?? false) ||
            nounLike(sameClauseNext) ||
            numeralLike(sameClauseNext) ||
            ['hier', 'dort', 'da', 'heute', 'morgen', 'gestern', 'oben', 'unten', 'früher', 'jetzt', 'wem', 'wen'].includes(sameClauseNext.lower)));
      const infinitiveAhead = w.lower === 'zu' && sameClauseNext?.readings.some((r) => r.entry.p === 'v' && r.codes.includes('inf') && r.via !== 'ending');
      if (infinitiveAhead && !startsPhrase) {
        w.kind = 'func';
        w.func = { pos: 'particle', lemma: 'zu', ru: 'частица перед инфинитивом (не переводится)', kind: 'Infinitivpartikel' };
        return;
      }
      // A parser tags a stranded verb prefix ("Pass auf!") as a preposition too; position decides.
      if (startsPhrase || (parsePos === 'ADP' && !w.last)) {
        w.kind = 'prep';
        if (head >= 0) w.head = head;
        return;
      }
    }
    if (w.pron && !(w.lower === 'ihr' && head >= 0)) {
      w.kind = 'pron';
      return;
    }
    if (w.det && !w.readings.some((r) => r.entry.p === 'v' && r.via !== 'ending')) {
      // "der", "das", "einer" on their own: demonstrative, relative or indefinite pronoun.
      w.kind = 'pron';
      const cases = [...new Set(w.det.slots.map((s) => s.c))];
      w.pron = {
        lemma: w.det.lemma,
        ru: w.det.lemma === 'der' ? (w.lower === 'das' ? 'это; который' : 'этот, тот; который') : w.det.ru,
        kind: w.det.lemma === 'der' ? 'Demonstrativ- oder Relativpronomen' : 'Pronomen',
        cases,
      };
      return;
    }
    if (w.func && !(SEPARABLE_SET.has(w.lower) && w.last)) {
      w.kind = 'func';
      return;
    }

    for (const r of w.readings) r.score = scoreReading(words, k, r, clausesWithFinite.has(w.clause));
    w.readings.sort((a, b) => b.score - a.score);
    const best = w.readings[0];
    if (!best) {
      w.kind = 'unknown';
      return;
    }
    w.chosen = best;
    if (best.via === 'ending') {
      w.kind = 'adj';
      const h = nounAhead(words, k);
      if (h >= 0) w.head = h;
      else if (nounLike(words[k + 1])) w.head = k + 1;
    } else if (isNounEntry(best.entry)) w.kind = 'noun';
    else if (best.entry.p === 'v') {
      w.kind = 'verb';
      if (best.codes.some(isFinite)) clausesWithFinite.add(w.clause);
    } else if (best.entry.p === 'a') w.kind = 'adj';
    else w.kind = 'other';
  });

  // A clause needs a finite verb. If none was chosen and the clause opens with a word that
  // can be an imperative or indicative form, that word is the verb: "Ruf mich an!", "Pass auf!".
  const openers = new Map<number, Word>();
  for (const w of words) if (!openers.has(w.clause)) openers.set(w.clause, w);
  for (const [clause, opener] of openers) {
    if (clausesWithFinite.has(clause) || opener.kind !== 'noun') continue;
    const verb = opener.readings.find((r) => r.entry.p === 'v' && r.via !== 'ending' && r.codes.some((c) => c[0] === 'm' || c.startsWith('ip') || c.startsWith('it')));
    if (!verb) continue;
    opener.chosen = verb;
    opener.kind = 'verb';
    clausesWithFinite.add(clause);
  }
}

// ───────────────────────── 4. verbs ─────────────────────────

interface Subject {
  person: Person;
  number: GrammaticalNumber | null;
}

function findSubject(clause: Word[]): Subject | null {
  for (const w of clause) {
    if (w.kind !== 'pron' || !w.pron) continue;
    const { lemma, cases, person, number } = w.pron;
    if (!cases.includes('nominative') || !person) continue;
    if (lemma === 'sie') return { person: 3, number: null };
    if (lemma === 'Sie') return { person: 3, number: 'plural' };
    return { person, number: number ?? null };
  }
  return null;
}

const codePerson = (code: string): Person | null => {
  const m = /^(?:ip|it|k1|k2)(\d)/.exec(code);
  return m ? (Number(m[1]) as Person) : null;
};
const codeNumber = (code: string): GrammaticalNumber => (code.endsWith('p') ? 'plural' : 'singular');
const codeGroup = (code: string): string => (code[0] === 'm' ? 'm' : code.slice(0, 2));

function describeFinite(state: VerbState, subject: Subject | null, clauseInitial: boolean): void {
  let codes = state.codes.filter(isFinite);
  if (codes.length === 0) return;
  let certainty: Certainty = 'certain';
  const imperative = codes.filter((c) => c[0] === 'm');
  if (imperative.length > 0 && (imperative.length === codes.length || (clauseInitial && !subject))) {
    state.mood = mark<Mood>('imperative', imperative.length === codes.length ? 'certain' : 'likely', 'rules');
    state.person = mark<Person[]>([2], 'certain', 'rules');
    state.number = mark(codeNumber(imperative[0]!), imperative.length === 1 ? 'certain' : 'likely', 'rules');
    state.tense = undefined;
    return;
  }
  codes = codes.filter((c) => c[0] !== 'm');
  if (subject) {
    const matching = codes.filter((c) => codePerson(c) === subject.person && (subject.number === null || codeNumber(c) === subject.number));
    if (matching.length > 0) codes = matching;
    else certainty = 'uncertain';
  } else {
    certainty = 'likely';
  }
  // Preference when several moods share one form: indicative present, preterite, Konjunktiv II, Konjunktiv I.
  const order = ['ip', 'it', 'k2', 'k1'];
  const groups = [...new Set(codes.map(codeGroup))].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const group = groups[0]!;
  if (groups.length > 1 && !(groups.length === 2 && groups.includes('ip') && groups.includes('k1'))) certainty = certainty === 'certain' ? 'likely' : certainty;
  const inGroup = codes.filter((c) => codeGroup(c) === group);
  const persons = [...new Set(inGroup.map((c) => codePerson(c)!))].sort() as Person[];
  const numbers = [...new Set(inGroup.map(codeNumber))];
  state.mood = mark<Mood>(group === 'k1' ? 'subjunctive1' : group === 'k2' ? 'subjunctive2' : 'indicative', certainty, 'rules');
  state.tense = mark<Tense>(group === 'it' ? 'preterite' : 'present', certainty, 'rules');
  state.person = mark(persons, persons.length > 1 && certainty === 'certain' ? 'likely' : certainty, 'rules');
  state.number = mark(numbers[0]!, numbers.length > 1 ? 'uncertain' : certainty, 'rules');
}

function verbState(w: Word): VerbState {
  const r = w.chosen!;
  const state: VerbState = { entry: r.entry, codes: r.codes, role: 'main', kind: 'finite' };
  if (r.entry.sep) state.sep = { prefix: r.entry.sep, separated: false };
  return state;
}

async function analyseVerbs(words: Word[], dict: Dictionary): Promise<void> {
  const clauses = new Map<number, Word[]>();
  for (const w of words) clauses.set(w.clause, [...(clauses.get(w.clause) ?? []), w]);
  const subjects = new Map<number, Subject | null>();
  const finiteOf = new Map<number, Word>();

  for (const [id, clause] of clauses) {
    const first = clause[0]!;
    const opener = SOFT_BOUNDARIES.has(first.lower) ? clause[1] : first;
    const subordinate =
      opener !== undefined &&
      (SUBORDINATORS.has(opener.lower) || (opener.kind === 'pron' && opener.det !== null && opener.hard > 0) || (opener.kind === 'prep' && clause[clause.indexOf(opener) + 1]?.det?.lemma === 'der' && opener.hard > 0 && clause.at(-1)?.kind === 'verb'));
    // A clause joined with "und" shares the subject of the clause before it.
    let subject = findSubject(clause);
    if (!subject) {
      const earlier = [...subjects.entries()].reverse().find(([cid]) => clauses.get(cid)?.[0]?.hard === first.hard);
      subject = earlier?.[1] ?? null;
    }
    subjects.set(id, subject);

    const verbs = clause.filter((w) => w.kind === 'verb' && w.chosen);
    for (const w of verbs) w.verb = verbState(w);
    const candidates = verbs.filter((w) => w.verb!.codes.some(isFinite));
    const finite = subordinate ? candidates[candidates.length - 1] : candidates[0];
    if (finite) finiteOf.set(id, finite);

    for (const w of verbs) {
      const state = w.verb!;
      const codes = state.codes;
      if (w === finite) {
        state.kind = 'finite';
        describeFinite(state, subject, w === opener);
      } else if (codes.includes('p2')) state.kind = 'participle2';
      else if (codes.includes('zu')) state.kind = 'zu-infinitive';
      else if (codes.includes('inf')) state.kind = 'infinitive';
      else if (codes.includes('p1')) state.kind = 'participle1';
      else {
        state.kind = 'finite';
        describeFinite(state, subject, false);
      }
    }
  }

  // Detached prefixes: the last word of a clause, if it is a prefix that forms a known verb
  // with the finite verb of that clause ("Ich stehe … auf" → aufstehen).
  for (const [id, clause] of clauses) {
    const candidate = clause[clause.length - 1]!;
    const viaParse = clause.find((w) => w.parse?.dep === 'svp');
    const prefix = viaParse ?? candidate;
    if (!SEPARABLE_SET.has(prefix.lower)) continue;
    if (!viaParse && (prefix.kind === 'det' || prefix.kind === 'prep' || prefix.kind === 'noun')) continue;
    // "teil" also reads as a form of "teilen"; at the end of a clause that already has its own
    // finite verb it is the detached half ("nimmt … teil"), provided the dictionary knows the verb.
    if (!viaParse && prefix.kind === 'verb' && prefix.verb?.kind === 'finite') {
      const other = finiteOf.get(id);
      if (!other || other === prefix) continue;
    }
    let finite = finiteOf.get(id);
    if (!finite || finite === prefix) {
      // "Er ruft Peter und Maria an": the verb sits in an earlier part of the same clause.
      for (let cid = id - 1; cid >= 0 && !finite; cid--) {
        const earlier = clauses.get(cid);
        if (!earlier || earlier[0]!.hard !== clause[0]!.hard) break;
        finite = finiteOf.get(cid);
      }
    }
    if (!finite || finite === prefix || !finite.verb || finite.verb.sep?.separated) continue;
    const base = finite.verb.entry;
    const joined = prefix.lower + base.w;
    let found: DictEntry | null = null;
    for (const hit of await dict.lookup(joined)) {
      const entry = await dict.entry(hit.id);
      if (entry && entry.p === 'v' && hit.codes.includes('inf')) {
        found = entry;
        if (entry.sep === prefix.lower) break;
      }
    }
    if (!found) continue;
    const sep: SeparableInfo = { prefix: prefix.lower, separated: true, prefixTokenIndex: prefix.i, verbTokenIndex: finite.i };
    finite.verb.entry = found;
    finite.verb.sep = sep;
    prefix.kind = 'verb';
    prefix.chosen = null;
    prefix.verb = { ...finite.verb, role: 'prefix', sep, note: `отделяемая приставка глагола ${found.w}` };
  }

  // Compound tenses, passive, modal constructions.
  const byHard = new Map<number, Word[]>();
  for (const w of words) byHard.set(w.hard, [...(byHard.get(w.hard) ?? []), w]);
  for (const group of byHard.values()) {
    const verbs = group.filter((w) => w.kind === 'verb' && w.verb && w.verb.role !== 'prefix');
    const helper = verbs.find((w) => w.verb!.kind === 'finite' && (AUXILIARIES.has(w.verb!.entry.w) || MODALS.has(w.verb!.entry.w)));
    if (!helper) continue;
    const state = helper.verb!;
    const lemma = state.entry.w;
    const participles = verbs.filter((w) => w !== helper && w.verb!.kind === 'participle2');
    const infinitives = verbs.filter((w) => w !== helper && w.verb!.kind === 'infinitive');
    const helperTense = state.tense?.value ?? 'present';
    const subjunctive = state.mood?.value === 'subjunctive2';
    const share = (target: VerbState): void => {
      target.person = state.person;
      target.number = state.number;
      if (subjunctive) target.mood = mark<Mood>('subjunctive2', 'likely', 'rules');
    };

    if (MODALS.has(lemma)) {
      if (infinitives.length > 0) {
        state.role = 'modal';
        state.note = `модальный глагол при ${infinitives.map((w) => w.verb!.entry.w).join(', ')}`;
      }
      continue;
    }
    if (lemma === 'werden') {
      const perfectInfinitive = infinitives.find((w) => AUXILIARIES.has(w.verb!.entry.w) && w.verb!.entry.w !== 'werden');
      if (participles.length > 0 && perfectInfinitive) {
        for (const p of participles) {
          p.verb!.tense = mark<Tense>('future2', 'likely', 'rules');
          share(p.verb!);
        }
        perfectInfinitive.verb!.role = 'auxiliary';
        state.role = 'auxiliary';
      } else if (participles.length > 0) {
        for (const p of participles) {
          p.verb!.voice = mark<Voice>('passive', 'likely', 'rules');
          p.verb!.tense = mark<Tense>(helperTense, 'likely', 'rules');
          share(p.verb!);
        }
        state.role = 'auxiliary';
        state.note = 'вспомогательный глагол пассива';
      } else if (infinitives.length > 0) {
        for (const inf of infinitives) {
          inf.verb!.tense = mark<Tense>('future1', 'likely', 'rules');
          share(inf.verb!);
        }
        state.role = 'auxiliary';
        state.note = subjunctive ? 'würde + инфинитив: сослагательное наклонение' : 'вспомогательный глагол будущего времени';
      }
      continue;
    }
    if (participles.length === 0) continue;
    state.role = 'auxiliary';
    state.note = `вспомогательный глагол при ${participles.map((w) => w.verb!.entry.pp ?? w.text).join(', ')}`;
    for (const p of participles) {
      const takesSein = (p.verb!.entry.aux ?? 'h').includes('s');
      if (lemma === 'sein' && !takesSein) {
        // "Die Tür ist geschlossen": a state, not the perfect tense of a haben-verb.
        p.verb!.voice = mark<Voice>('passive', 'likely', 'rules');
        p.verb!.tense = mark<Tense>(helperTense, 'likely', 'rules');
        p.verb!.note = 'Zustandspassiv: результат действия';
      } else {
        p.verb!.tense = mark<Tense>(helperTense === 'preterite' || subjunctive ? 'pluperfect' : 'perfect', 'likely', 'rules');
      }
      share(p.verb!);
    }
  }
}

// ───────────────────────── 5. noun phrases ─────────────────────────

interface NounSlot {
  c: GrammaticalCase;
  n: GrammaticalNumber;
}

function nounSlots(reading: Reading): NounSlot[] {
  const slots: NounSlot[] = [];
  for (const code of reading.codes) {
    if (!code.startsWith('N')) continue;
    const mask = Number.parseInt(code.slice(1), 16);
    for (let bit = 0; bit < 8; bit++) {
      if (mask & (1 << bit)) slots.push({ c: CASE_ORDER[bit % 4]!, n: bit >= 4 ? 'plural' : 'singular' });
    }
  }
  return slots;
}

const gendersOf = (entry: DictEntry): Gender[] => (entry.g && entry.g !== 'p' ? ([...entry.g] as Gender[]) : []);

function resolveNounPhrases(words: Word[]): void {
  const clauseVerb = new Map<number, string>();
  const clauseNominative = new Map<number, boolean>();
  for (const w of words) {
    if (w.kind === 'verb' && w.verb && w.verb.role !== 'prefix' && !clauseVerb.has(w.hard)) clauseVerb.set(w.hard, w.verb.entry.w);
    if (w.kind === 'pron' && w.pron && w.pron.cases.length === 1 && w.pron.cases[0] === 'nominative') clauseNominative.set(w.clause, true);
  }
  // The full verb decides, not the auxiliary: "hat … geholfen" governs the dative.
  for (const w of words) if (w.kind === 'verb' && w.verb && (w.verb.kind === 'participle2' || w.verb.kind === 'infinitive')) clauseVerb.set(w.hard, w.verb.entry.w);

  const nouns = words.map((w, k) => ({ w, k })).filter(({ w }) => w.kind === 'noun' && w.chosen);
  // Pass 1 settles what articles and prepositions decide; pass 2 uses that to tell subject from object.
  for (const pass of [1, 2]) {
    for (const { w, k } of nouns) {
      if (pass === 2 && w.np && w.np.cases.length === 1 && w.np.certainty !== 'uncertain') continue;
      const reading = w.chosen!;
      const genders = gendersOf(reading.entry);
      const det = words.find((x, j) => j < k && x.kind === 'det' && x.head === k && x.clause === w.clause);
      const prep = words.find((x, j) => j < k && x.kind === 'prep' && x.clause === w.clause && (x.head === k || j === k - 1 || (det !== undefined && words[j + 1] === det)));
      let slots = nounSlots(reading);
      if (slots.length === 0) slots = CASE_ORDER.flatMap((c) => [{ c, n: 'singular' as const }, { c, n: 'plural' as const }]);
      const genusFits = (g: Genus, n: GrammaticalNumber): boolean => (n === 'plural' ? g === 'pl' : g !== 'pl' && (genders.length === 0 || genders.includes(g)));
      const fits = (s: NounSlot, useDet: boolean, usePrep: boolean): boolean => {
        if (useDet && det?.det && !det.det.slots.some((d: Slot) => d.c === s.c && genusFits(d.g, s.n))) return false;
        if (usePrep && prep?.prep) {
          if (!prep.prep.cases.includes(s.c)) return false;
          if (prep.prep.genders && !prep.prep.genders.some((g) => genusFits(g, s.n))) return false;
        }
        return true;
      };
      let candidates = slots.filter((s) => fits(s, true, true));
      let certainty: Certainty = det || prep ? 'certain' : 'likely';
      if (candidates.length === 0) {
        // The dictionary form table and the context disagree: trust the context, flag the result.
        candidates = slots.filter((s) => fits(s, false, true));
        if (candidates.length === 0) candidates = slots;
        certainty = 'uncertain';
      }
      // Number: prefer the reading in which the word is not simply the base form with a plural article missing.
      let numbers = [...new Set(candidates.map((s) => s.n))];
      if (numbers.length > 1) {
        const prefer: GrammaticalNumber = w.text === reading.entry.w && reading.entry.g !== 'p' ? 'singular' : 'plural';
        candidates = candidates.filter((s) => s.n === prefer);
        numbers = [prefer];
        if (!det) certainty = certainty === 'certain' ? 'likely' : certainty;
      }
      let cases = [...new Set(candidates.map((s) => s.c))];
      const verb = clauseVerb.get(w.hard);

      if (cases.length > 1 && pass === 2) {
        const narrow = (keep: GrammaticalCase, level: Certainty = 'likely'): void => {
          cases = [keep];
          if (certainty === 'certain') certainty = level;
        };
        const has = (c: GrammaticalCase): boolean => cases.includes(c);
        if (prep?.prep && prep.prep.cases[0] === 'genitive' && has('genitive')) {
          // trotz, wegen, während: the genitive is the standard, the dative is colloquial.
          narrow('genitive');
        } else if (prep?.prep && has('dative') && has('accusative')) {
          narrow(verb && MOTION_VERBS.has(verb) ? 'accusative' : 'dative', 'uncertain');
        } else if (has('genitive') && (has('dative') || has('nominative'))) {
          // "die Farbe der Tür": a noun directly before the article points to a genitive attribute.
          const before = words[(det ? words.indexOf(det) : k) - 1];
          if (before && before.kind === 'noun' && before.clause === w.clause) narrow('genitive');
          else cases = cases.filter((c) => c !== 'genitive');
        }
        if (cases.length > 1 && has('nominative') && has('accusative')) {
          if (verb && COPULAS.has(verb)) narrow('nominative');
          else if (!clauseNominative.get(w.clause)) {
            narrow('nominative');
            clauseNominative.set(w.clause, true);
          } else narrow('accusative');
        }
        if (cases.length > 1 && has('dative') && has('accusative')) narrow(verb && DATIVE_VERBS.has(verb) ? 'dative' : 'accusative', 'uncertain');
        if (cases.length > 1) certainty = 'uncertain';
      } else if (cases.length === 1 && cases[0] === 'nominative' && pass === 1) {
        clauseNominative.set(w.clause, true);
      }

      // The article narrows the gender of nouns that have more than one.
      let gender = genders;
      if (det?.det && genders.length > 1 && numbers[0] === 'singular') {
        const allowed = genders.filter((g) => det.det!.slots.some((d: Slot) => d.g === g && cases.includes(d.c)));
        if (allowed.length > 0) gender = allowed;
      }
      w.np = { cases, number: numbers[0], gender, certainty };
    }
  }

  // A noun in the nominative is a third-person subject: "Die Kinder spielen" is not "wir spielen".
  for (const w of words) {
    const state = w.verb;
    if (!state || state.kind !== 'finite' || !state.person || state.person.certainty === 'certain' || state.mood?.value === 'imperative') continue;
    const hasPronounSubject = words.some((x) => x.clause === w.clause && x.kind === 'pron' && x.pron?.cases.includes('nominative') && x.pron.person !== undefined);
    const subject = words.find((x) => x.clause === w.clause && x.kind === 'noun' && x.np?.cases.length === 1 && x.np.cases[0] === 'nominative');
    if (hasPronounSubject || !subject?.np?.number) continue;
    const fitting = state.codes.filter((c) => codePerson(c) === 3 && codeNumber(c) === subject.np!.number && codeGroup(c) === codeGroup(state.codes.find(isFinite) ?? c));
    if (fitting.length === 0 && !state.codes.some((c) => codePerson(c) === 3 && codeNumber(c) === subject.np!.number)) continue;
    state.person = mark<Person[]>([3], 'likely', 'rules');
    state.number = mark(subject.np.number, 'likely', 'rules');
  }

  // Articles, adjectives and prepositions take over the result of their noun.
  for (const w of words) {
    if (w.head === undefined) continue;
    const noun = words[w.head];
    if (noun?.np && (w.kind === 'det' || w.kind === 'adj' || w.kind === 'prep')) w.np = noun.np;
  }
  // Pronouns whose form is ambiguous between nominative and accusative.
  for (const w of words) {
    if (w.kind !== 'pron' || !w.pron || w.np) continue;
    let cases = w.pron.cases;
    let certainty: Certainty = 'certain';
    if (cases.length > 1) {
      const prev = words[words.indexOf(w) - 1];
      if (prev && prev.kind === 'prep' && prev.prep && prev.clause === w.clause) {
        const allowed = cases.filter((c) => prev.prep!.cases.includes(c));
        if (allowed.length > 0) cases = allowed;
      }
      if (cases.includes('nominative') && cases.includes('accusative')) {
        if (!clauseNominative.get(w.clause)) {
          cases = ['nominative'];
          clauseNominative.set(w.clause, true);
        } else cases = ['accusative'];
        certainty = 'likely';
      } else if (cases.length > 1) certainty = 'uncertain';
    }
    w.np = { cases, number: w.pron.number, certainty };
  }
}

// ───────────────────────── 6. refinement with a dependency parse ─────────────────────────

const MORPH_CASE: Record<string, GrammaticalCase> = { Nom: 'nominative', Acc: 'accusative', Dat: 'dative', Gen: 'genitive' };
const MORPH_GENDER: Record<string, Gender> = { Masc: 'm', Fem: 'f', Neut: 'n' };

function applyParse(words: Word[]): void {
  for (const w of words) {
    const morph = w.parse?.morph;
    if (!morph) continue;
    const parsedCase = morph.Case ? MORPH_CASE[morph.Case] : undefined;
    if (parsedCase && (w.kind === 'noun' || w.kind === 'det' || w.kind === 'adj' || w.kind === 'pron')) {
      const number: GrammaticalNumber | undefined = morph.Number === 'Plur' ? 'plural' : morph.Number === 'Sing' ? 'singular' : undefined;
      const gender = morph.Gender ? MORPH_GENDER[morph.Gender] : undefined;
      // The parser sees the whole sentence; our form tables say what is possible at all.
      const possible = w.kind === 'noun' && w.chosen ? nounSlots(w.chosen) : [];
      const consistent = possible.length === 0 || possible.some((s) => s.c === parsedCase && (!number || s.n === number));
      const agrees = w.np?.cases.includes(parsedCase) ?? false;
      w.np = {
        cases: [parsedCase],
        number: number ?? w.np?.number,
        gender: gender && (w.kind !== 'noun' || !w.chosen || gendersOf(w.chosen.entry).length !== 1) ? [gender] : w.np?.gender,
        certainty: consistent ? (agrees || !w.np ? 'certain' : 'likely') : 'uncertain',
      };
      (w.np as NpState & { parsed?: boolean }).parsed = true;
    }
    const state = w.verb;
    if (state && state.role !== 'prefix' && morph.VerbForm === 'Fin' && state.kind === 'finite') {
      const person = morph.Person ? (Number(morph.Person) as Person) : undefined;
      const number: GrammaticalNumber | undefined = morph.Number === 'Plur' ? 'plural' : morph.Number === 'Sing' ? 'singular' : undefined;
      const allowed = state.codes.filter((c) => (!person || codePerson(c) === person) && (!number || codeNumber(c) === number));
      if (person && number && (allowed.length > 0 || !state.codes.some(isFinite))) {
        state.person = mark<Person[]>([person], 'certain', 'parser');
        state.number = mark(number, 'certain', 'parser');
        if (morph.Mood === 'Imp') state.mood = mark<Mood>('imperative', 'certain', 'parser');
      }
    }
  }
}

// ───────────────────────── 7. building the result ─────────────────────────

function alternatives(w: Word, chosenLemma: string, chosenPos: PartOfSpeech): AlternativeReading[] | undefined {
  const out: AlternativeReading[] = [];
  for (const r of w.readings) {
    if (r === w.chosen) continue;
    const pos = POS_OF[r.entry.p];
    if ((r.entry.w === chosenLemma && pos === chosenPos) || out.some((a) => a.lemma === r.entry.w && a.pos === pos)) continue;
    // Readings that capitalisation rules out are noise, not alternatives.
    if (isNounEntry(r.entry) && !w.cap) continue;
    if (w.chosen && w.chosen.score - r.score > 6) continue;
    out.push({ pos, lemma: r.entry.w, gloss: r.entry.ru?.[0] });
    if (out.length === 2) break;
  }
  return out.length > 0 ? out : undefined;
}

/** Other dictionary entries with the same lemma and part of speech: "die Bank" (банк / скамья). */
function homonyms(w: Word, entry: DictEntry): DictEntry[] {
  const out: DictEntry[] = [];
  for (const r of w.readings) {
    const x = r.entry;
    if (x === entry || x.w !== entry.w || POS_OF[x.p] !== POS_OF[entry.p] || !x.ru?.length || out.includes(x)) continue;
    // "der See" (озеро) and "die See" (море) differ by gender: the article decides, no merge.
    if (isNounEntry(entry)) {
      const a = gendersOf(entry), b = gendersOf(x);
      if (a.length > 0 && b.length > 0 && !a.some((g) => b.includes(g))) continue;
    }
    out.push(x);
  }
  return out;
}

function common(w: Word, entry: DictEntry, translation: string | undefined, homs: DictEntry[] = homonyms(w, entry)): Pick<NounAnalysis, 'surface' | 'tokenIndex' | 'translation' | 'definitions' | 'synonyms' | 'usage' | 'example'> {
  // Homonyms share one sense list, so the sentence translation can pick any of them and a
  // guess without evidence is marked as one.
  const senses = [...(entry.ru ?? [])];
  for (const h of homs) for (const s of h.ru!) if (!senses.includes(s)) senses.push(s);
  return {
    surface: w.text,
    tokenIndex: w.i,
    translation: pickSense(senses, translation, entry.mt === 1),
    definitions: entry.de,
    synonyms: entry.syn,
    usage: entry.tg,
    example: entry.ex ? { de: entry.ex[0], ru: entry.ex[1] } : undefined,
  };
}

function lemmaCertainty(w: Word): Certainty {
  const r = w.chosen;
  if (!r) return 'uncertain';
  if (r.via === 'elided' || r.via === 'compound' || r.via === 'joined') return 'likely';
  const rival = w.readings.find((x) => x !== r && (x.entry.w !== r.entry.w || x.entry.p !== r.entry.p) && !(isNounEntry(x.entry) && !w.cap));
  return rival && r.score - rival.score < 1 ? 'likely' : 'certain';
}

function buildNoun(w: Word, translation: string | undefined): NounAnalysis {
  const r = w.chosen!;
  const e = r.entry;
  const certainty = lemmaCertainty(w);
  const genders = w.np?.gender?.length ? w.np.gender : gendersOf(e);
  const source: InfoSource = (w.np as (NpState & { parsed?: boolean }) | undefined)?.parsed ? 'parser' : 'rules';
  const homs = homonyms(w, e);
  const info = common(w, e, translation, homs);
  // The plural follows the meaning: "Banken" for банк, "Bänke" for скамья.
  const meant = info.translation.contextual?.certainty === 'likely' ? info.translation.contextual.value : undefined;
  const owner = meant ? [e, ...homs].find((x) => x.ru?.some((s) => equivalents(s).includes(meant))) : undefined;
  const pe = owner ?? e;
  const pluralsDiffer = !owner && homs.some((h) => h.pl && pe.pl && h.pl.join() !== pe.pl.join());
  return {
    kind: 'noun',
    ...info,
    pos: mark<PartOfSpeech>(e.p === 'name' ? 'proper-noun' : 'noun', certainty),
    lemma: mark(e.w, certainty),
    gender: genders.length > 0 ? mark(genders, genders.length > 1 ? 'uncertain' : r.via === 'compound' ? 'likely' : 'certain') : undefined,
    singular: e.g === 'p' ? undefined : e.w,
    plural: pe.g === 'p' ? mark([pe.w]) : pe.pl ? mark(pe.pl, r.via === 'compound' || pluralsDiffer ? 'likely' : 'certain') : undefined,
    genitiveSingular: e.gs,
    case: w.np ? mark(w.np.cases, w.np.certainty, source) : undefined,
    number: w.np?.number ? mark(w.np.number, w.np.certainty === 'uncertain' ? 'likely' : w.np.certainty, source) : undefined,
    compoundParts: r.parts,
    alternatives: alternatives(w, e.w, 'noun'),
    notes: r.via === 'compound' ? ['составное слово: перевод дан для последней части'] : undefined,
  };
}

function buildVerb(w: Word, translation: string | undefined): VerbAnalysis {
  const state = w.verb!;
  const e = state.entry;
  const vp = e.vp;
  const present: PresentConjugation | undefined = vp && vp.length === 6 ? { ich: vp[0]!, du: vp[1]!, er: vp[2]!, wir: vp[3]!, ihr: vp[4]!, sie: vp[5]! } : undefined;
  const aux = (e.aux ?? '').split('').map((c): Auxiliary => (c === 's' ? 'sein' : 'haben'));
  const inseparable = !e.sep ? INSEPARABLE_PREFIXES.find((p) => e.w.startsWith(p) && e.w.length > p.length + 3 && e.pp !== undefined && !e.pp.startsWith('ge')) : undefined;
  const certainty = w.chosen ? lemmaCertainty(w) : 'certain';
  const notes = [state.note].filter((n): n is string => Boolean(n));
  return {
    kind: 'verb',
    ...common(w, e, translation),
    pos: mark<PartOfSpeech>('verb', certainty),
    lemma: mark(e.w, certainty),
    infinitive: e.w,
    partizip2: e.pp,
    praeteritum: e.vt,
    present,
    auxiliary: aux.length > 0 ? mark(aux, aux.length > 1 ? 'likely' : 'certain') : undefined,
    separable: state.sep,
    inseparablePrefix: inseparable,
    reflexive: e.refl ? mark(true, e.refl === 1 ? 'certain' : 'likely') : undefined,
    role: state.role,
    form: { kind: state.kind, tense: state.tense, mood: state.mood, voice: state.voice, person: state.person, number: state.number },
    alternatives: w.chosen ? alternatives(w, w.chosen.entry.w, 'verb') : undefined,
    notes: notes.length > 0 ? notes : undefined,
  };
}

function buildAdjective(w: Word, translation: string | undefined): AdjectiveAnalysis {
  const r = w.chosen!;
  const e = r.entry;
  const participle = e.p === 'v';
  const degreeCode = r.codes.find(isAdjCode);
  const degree: AdjectiveDegree = degreeCode?.endsWith('2') ? 'superlative' : degreeCode?.endsWith('1') ? 'comparative' : 'positive';
  const lemma = participle ? (r.codes.includes('p2') ? (e.pp ?? e.w) : `${e.w}d`) : e.w;
  const certainty = lemmaCertainty(w);
  const source: InfoSource = (w.np as (NpState & { parsed?: boolean }) | undefined)?.parsed ? 'parser' : 'rules';
  const declined = r.via === 'ending';
  return {
    kind: 'adjective',
    ...common(w, e, translation),
    pos: mark<PartOfSpeech>('adjective', participle ? 'likely' : certainty),
    lemma: mark(lemma, certainty),
    comparative: participle ? undefined : e.cmp,
    superlative: participle ? undefined : e.sup,
    degree: mark(degree, 'certain', 'rules'),
    case: declined && w.np ? mark(w.np.cases, w.np.certainty, source) : undefined,
    number: declined && w.np?.number ? mark(w.np.number, w.np.certainty, source) : undefined,
    gender: declined && w.np?.gender?.length && w.np.number === 'singular' ? mark(w.np.gender, w.np.certainty, source) : undefined,
    usage2: declined ? 'attributive' : 'predicative',
    alternatives: alternatives(w, e.w, 'adjective'),
    notes: participle ? [`${r.codes.includes('p2') ? 'Partizip II' : 'Partizip I'} глагола ${e.w}`] : undefined,
  };
}

const CASE_NAME: Record<GrammaticalCase, string> = { nominative: 'Nominativ', accusative: 'Akkusativ', dative: 'Dativ', genitive: 'Genitiv' };
const GENDER_NAME: Record<Gender, string> = { m: 'maskulin', f: 'feminin', n: 'neutral' };

function phraseFeatures(np: NpState | undefined): GrammarFeature[] {
  if (!np) return [];
  const source: InfoSource = (np as NpState & { parsed?: boolean }).parsed ? 'parser' : 'rules';
  const features: GrammarFeature[] = [{ key: 'case', value: mark(np.cases.map((c) => CASE_NAME[c]).join(' / '), np.certainty, source) }];
  if (np.number) features.push({ key: 'number', value: mark(np.number === 'plural' ? 'Plural' : 'Singular', np.certainty, source) });
  if (np.gender?.length && np.number !== 'plural') features.push({ key: 'gender', value: mark(np.gender.map((g) => GENDER_NAME[g]).join(' / '), np.gender.length > 1 ? 'uncertain' : np.certainty, source) });
  return features;
}

function buildClosed(w: Word): OtherAnalysis {
  const builtin = <T>(value: T): Marked<T> => mark(value, 'certain', 'builtin');
  const base = { kind: 'other' as const, surface: w.text, tokenIndex: w.i };
  if (w.kind === 'det' && w.det) {
    return {
      ...base,
      pos: builtin<PartOfSpeech>('determiner'),
      lemma: builtin(w.det.lemma),
      translation: { contextual: builtin(w.det.ru), senses: [] },
      features: [{ key: 'type', value: builtin(w.det.kind) }, ...phraseFeatures(w.np)],
    };
  }
  if (w.kind === 'prep' && w.prep) {
    const features: GrammarFeature[] = [{ key: 'governs', value: builtin(w.prep.cases.map((c) => CASE_NAME[c]).join(' oder ')) }];
    if (w.prep.contraction) features.push({ key: 'contraction', value: builtin(w.prep.contraction) });
    if (w.np && w.prep.cases.length > 1) features.push({ key: 'case', value: mark(w.np.cases.map((c) => CASE_NAME[c]).join(' / '), w.np.certainty, 'rules') });
    return { ...base, pos: builtin<PartOfSpeech>('preposition'), lemma: builtin(w.prep.lemma), translation: { contextual: builtin(w.prep.ru), senses: [] }, features };
  }
  if (w.kind === 'pron' && w.pron) {
    const features: GrammarFeature[] = [{ key: 'type', value: builtin(w.pron.kind) }, ...phraseFeatures(w.np)];
    if (w.pron.person && w.pron.lemma !== 'sich') features.push({ key: 'person', value: builtin(`${w.pron.person}. Person`) });
    return { ...base, pos: builtin<PartOfSpeech>('pronoun'), lemma: builtin(w.pron.lemma), translation: { contextual: builtin(w.pron.ru), senses: [] }, features };
  }
  const func = w.func!;
  return { ...base, pos: builtin(func.pos), lemma: builtin(func.lemma), translation: { contextual: builtin(func.ru), senses: [] }, features: [{ key: 'type', value: builtin(func.kind) }] };
}

function buildOther(w: Word, translation: string | undefined): OtherAnalysis {
  const r = w.chosen;
  if (!r) {
    // Capitalised and unknown inside a sentence: most likely a name.
    const pos: PartOfSpeech = w.cap && !w.start ? 'proper-noun' : 'unknown';
    return { kind: 'other', surface: w.text, tokenIndex: w.i, pos: mark(pos, 'uncertain', 'rules'), lemma: mark(w.text, 'uncertain', 'rules'), translation: { senses: [] }, features: [] };
  }
  const e = r.entry;
  const certainty = lemmaCertainty(w);
  const pos = POS_OF[e.p];
  return {
    kind: 'other',
    ...common(w, e, translation),
    pos: mark(pos, certainty),
    lemma: mark(e.w, certainty),
    features: e.cmp ? [{ key: 'type', value: mark(`Komparativ: ${e.cmp}`) }] : [],
    alternatives: alternatives(w, e.w, pos),
  };
}

function build(w: Word, translation: string | undefined): WordAnalysis {
  if (w.kind === 'verb' && w.verb) return buildVerb(w, translation);
  if (w.kind === 'noun' && w.chosen) return buildNoun(w, translation);
  if (w.kind === 'adj' && w.chosen) return buildAdjective(w, translation);
  if ((w.kind === 'det' && w.det) || (w.kind === 'prep' && w.prep) || (w.kind === 'pron' && w.pron) || (w.kind === 'func' && w.func)) return buildClosed(w);
  return buildOther(w, translation);
}

/**
 * Analyses every word of a German sentence. The result has one entry per token of
 * `tokenize(text)`; punctuation and numbers are null.
 */
export async function analyzeSentence(text: string, dict: Dictionary, options: AnalyzeOptions = {}): Promise<(WordAnalysis | null)[]> {
  const tokens = tokenize(text);
  const words = await prepare(tokens, dict);
  attachParse(words, tokens, options.parse);
  classify(words);
  await analyseVerbs(words, dict);
  resolveNounPhrases(words);
  applyParse(words);
  const result: (WordAnalysis | null)[] = tokens.map(() => null);
  for (const w of words) result[w.i] = build(w, options.translation);
  return result;
}

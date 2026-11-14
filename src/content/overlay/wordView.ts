// Turns a structured WordAnalysis into the rows shown in the word panel.
// Grammar terms stay German (Kasus, Präteritum, …): these are the words a learner meets in
// every textbook. Everything else in the panel is Russian.
import { equivalents } from '../../nlp/senses.ts';
import type {
  AdjectiveAnalysis,
  Certainty,
  ExampleSentence,
  Gender,
  GrammaticalCase,
  GrammaticalNumber,
  InfoSource,
  Marked,
  Mood,
  NounAnalysis,
  OtherAnalysis,
  PartOfSpeech,
  Tense,
  VerbAnalysis,
  WordAnalysis,
} from '../../shared/types';

export interface PopupRow {
  label: string;
  value: string;
  uncertain: boolean;
}

export interface PopupView {
  article?: { text: string; cls: 'm' | 'f' | 'n' | 'p' };
  title: string;
  tags: string[];
  translation?: { text: string; uncertain: boolean; source: InfoSource };
  rows: PopupRow[];
  conjugation?: string[][];
  otherSenses: string[];
  alternatives: string[];
  definition?: string;
  example?: ExampleSentence;
  notes: string[];
  hasUncertain: boolean;
}

const POS_LABEL: Record<PartOfSpeech, string> = {
  noun: 'Substantiv',
  'proper-noun': 'Eigenname',
  verb: 'Verb',
  adjective: 'Adjektiv',
  adverb: 'Adverb',
  pronoun: 'Pronomen',
  determiner: 'Artikelwort',
  preposition: 'Präposition',
  conjunction: 'Konjunktion',
  particle: 'Partikel',
  numeral: 'Zahlwort',
  interjection: 'Interjektion',
  unknown: 'unbekannt',
};

export const CASE_LABEL: Record<GrammaticalCase, string> = { nominative: 'Nominativ', accusative: 'Akkusativ', dative: 'Dativ', genitive: 'Genitiv' };
export const NUMBER_LABEL: Record<GrammaticalNumber, string> = { singular: 'Singular', plural: 'Plural' };
export const GENDER_LABEL: Record<Gender, string> = { m: 'maskulin', f: 'feminin', n: 'neutral' };
const ARTICLE: Record<Gender, string> = { m: 'der', f: 'die', n: 'das' };
export const TENSE_LABEL: Record<Tense, string> = {
  present: 'Präsens',
  preterite: 'Präteritum',
  perfect: 'Perfekt',
  pluperfect: 'Plusquamperfekt',
  future1: 'Futur I',
  future2: 'Futur II',
};
export const MOOD_LABEL: Record<Mood, string> = { indicative: 'Indikativ', subjunctive1: 'Konjunktiv I', subjunctive2: 'Konjunktiv II', imperative: 'Imperativ' };

const unsure = (c: Certainty | undefined): boolean => c !== undefined && c !== 'certain';
const anyUnsure = (...marked: (Marked<unknown> | undefined)[]): boolean => marked.some((m) => unsure(m?.certainty));

function caseText(cases: GrammaticalCase[]): string {
  return cases.map((c) => CASE_LABEL[c]).join(' / ');
}

function nounRows(a: NounAnalysis): PopupRow[] {
  const rows: PopupRow[] = [];
  if (a.case || a.number) {
    const parts = [a.case ? caseText(a.case.value) : '', a.number ? NUMBER_LABEL[a.number.value] : ''].filter(Boolean);
    rows.push({ label: 'Im Satz', value: parts.join(' '), uncertain: anyUnsure(a.case, a.number) });
  }
  if (a.plural) {
    const article = 'die ';
    rows.push({ label: 'Plural', value: a.plural.value.length > 0 ? a.plural.value.map((p) => article + p).join(', ') : 'kein Plural', uncertain: unsure(a.plural.certainty) });
  }
  if (a.genitiveSingular?.length) {
    const g = a.gender?.value[0];
    const article = g === 'f' ? 'der ' : g ? 'des ' : '';
    rows.push({ label: 'Genitiv', value: a.genitiveSingular.map((f) => article + f).join(', '), uncertain: false });
  }
  if (a.compoundParts?.length) rows.push({ label: 'Zusammensetzung', value: a.compoundParts.join(' + '), uncertain: true });
  return rows;
}

function personText(v: VerbAnalysis): string {
  const f = v.form;
  if (!f.person || !f.number) return '';
  return `${f.person.value.join('./')}. Person ${NUMBER_LABEL[f.number.value]}`;
}

function verbRows(a: VerbAnalysis): PopupRow[] {
  const rows: PopupRow[] = [];
  const f = a.form;
  const formParts: string[] = [];
  if (f.kind === 'infinitive') formParts.push('Infinitiv');
  else if (f.kind === 'zu-infinitive') formParts.push('Infinitiv mit zu');
  else if (f.kind === 'participle2') formParts.push('Partizip II');
  else if (f.kind === 'participle1') formParts.push('Partizip I');
  if (f.tense) formParts.push(TENSE_LABEL[f.tense.value]);
  if (f.mood && f.mood.value !== 'indicative') formParts.push(MOOD_LABEL[f.mood.value]);
  if (f.voice?.value === 'passive') formParts.push('Passiv');
  const person = personText(a);
  if (person) formParts.push(person);
  if (formParts.length > 0) {
    rows.push({ label: 'Im Satz', value: formParts.join(', '), uncertain: anyUnsure(f.tense, f.mood, f.person, f.number, f.voice) });
  }
  if (a.role === 'auxiliary') rows.push({ label: 'Rolle', value: 'Hilfsverb', uncertain: false });
  if (a.role === 'modal') rows.push({ label: 'Rolle', value: 'Modalverb', uncertain: false });
  if (a.praeteritum) rows.push({ label: 'Präteritum', value: a.praeteritum, uncertain: false });
  if (a.partizip2) rows.push({ label: 'Partizip II', value: a.partizip2, uncertain: false });
  if (a.auxiliary) rows.push({ label: 'Hilfsverb', value: a.auxiliary.value.join(' / '), uncertain: unsure(a.auxiliary.certainty) });
  if (a.separable) {
    rows.push({ label: 'Präfix', value: `${a.separable.prefix}- (trennbar${a.separable.separated ? ', im Satz abgetrennt' : ''})`, uncertain: false });
  } else if (a.inseparablePrefix) {
    rows.push({ label: 'Präfix', value: `${a.inseparablePrefix}- (untrennbar)`, uncertain: false });
  }
  if (a.reflexive?.value) rows.push({ label: 'Reflexiv', value: `sich ${a.infinitive}`, uncertain: unsure(a.reflexive.certainty) });
  return rows;
}

function adjectiveRows(a: AdjectiveAnalysis): PopupRow[] {
  const rows: PopupRow[] = [];
  const inSentence: string[] = [];
  if (a.degree && a.degree.value !== 'positive') inSentence.push(a.degree.value === 'comparative' ? 'Komparativ' : 'Superlativ');
  if (a.usage2 === 'predicative') inSentence.push('unflektiert');
  if (a.case) inSentence.push(caseText(a.case.value));
  if (a.number) inSentence.push(NUMBER_LABEL[a.number.value]);
  if (a.gender) inSentence.push(a.gender.value.map((g) => GENDER_LABEL[g]).join(' / '));
  if (inSentence.length > 0) rows.push({ label: 'Im Satz', value: inSentence.join(', '), uncertain: anyUnsure(a.degree, a.case, a.number, a.gender) });
  if (a.comparative) rows.push({ label: 'Komparativ', value: a.comparative, uncertain: false });
  if (a.superlative) rows.push({ label: 'Superlativ', value: a.superlative, uncertain: false });
  return rows;
}

const FEATURE_LABEL: Record<string, string> = {
  case: 'Kasus',
  governs: 'Regiert',
  person: 'Person',
  number: 'Numerus',
  gender: 'Genus',
  type: 'Art',
  contraction: 'Verschmelzung',
  refersTo: 'Gehört zu',
};

function otherRows(a: OtherAnalysis): PopupRow[] {
  return a.features.map((f) => ({ label: FEATURE_LABEL[f.key] ?? f.key, value: f.value.value, uncertain: unsure(f.value.certainty) }));
}

function conjugation(a: VerbAnalysis): string[][] | undefined {
  const p = a.present;
  if (!p) return undefined;
  return [
    ['ich', p.ich],
    ['wir', p.wir],
    ['du', p.du],
    ['ihr', p.ihr],
    ['er/sie/es', p.er],
    ['sie/Sie', p.sie],
  ];
}

/** Builds the view model of the word panel. */
export function buildPopupView(a: WordAnalysis): PopupView {
  const tags = [POS_LABEL[a.pos.value]];
  let article: PopupView['article'];
  let rows: PopupRow[];
  let conj: string[][] | undefined;
  let title = a.lemma.value;

  switch (a.kind) {
    case 'noun': {
      const genders = a.gender?.value ?? [];
      const first = genders[0];
      if (first) article = { text: genders.map((g) => ARTICLE[g]).join('/'), cls: first };
      else if (a.plural && a.number?.value === 'plural' && !a.singular) article = { text: 'die', cls: 'p' };
      if (genders.length > 0) tags.push(genders.map((g) => GENDER_LABEL[g]).join('/'));
      rows = nounRows(a);
      break;
    }
    case 'verb':
      title = a.infinitive;
      if (a.separable) tags.push('trennbar');
      rows = verbRows(a);
      conj = conjugation(a);
      break;
    case 'adjective':
      rows = adjectiveRows(a);
      break;
    default:
      rows = otherRows(a);
  }

  const contextual = a.translation.contextual;
  // The meaning shown on top is not repeated; the rest of its sense stays ("подниматься" next to "вставать").
  const otherSenses: string[] = [];
  for (const sense of a.translation.senses) {
    const parts = equivalents(sense);
    if (!contextual || !parts.includes(contextual.value)) otherSenses.push(sense);
    else if (parts.length > 1) otherSenses.push(parts.filter((e) => e !== contextual.value).join(', '));
  }
  otherSenses.splice(4);
  const alternatives = (a.alternatives ?? []).slice(0, 3).map((alt) => {
    const head = `${alt.lemma} (${POS_LABEL[alt.pos]}${alt.note ? `, ${alt.note}` : ''})`;
    return alt.gloss ? `${head}: ${alt.gloss}` : head;
  });

  const view: PopupView = {
    article,
    title,
    tags: unsure(a.pos.certainty) ? tags.map((t, i) => (i === 0 ? `${t}?` : t)) : tags,
    translation: contextual ? { text: contextual.value, uncertain: unsure(contextual.certainty), source: contextual.source } : undefined,
    rows,
    conjugation: conj,
    otherSenses,
    alternatives,
    definition: a.definitions?.[0],
    example: a.example,
    notes: a.notes ?? [],
    hasUncertain: false,
  };
  view.hasUncertain =
    rows.some((r) => r.uncertain) || Boolean(view.translation?.uncertain) || unsure(a.pos.certainty) || unsure(a.lemma.certainty);
  return view;
}

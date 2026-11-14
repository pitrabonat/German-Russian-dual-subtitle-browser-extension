// Hand-written knowledge about German function words. They are few, extremely frequent and
// irregular, so a table is both more precise and faster than dictionary lookups.
import type { Gender, GrammaticalCase, GrammaticalNumber, PartOfSpeech, Person } from '../shared/types';

/** Gender of a singular noun phrase, or `pl` for any plural one. */
export type Genus = Gender | 'pl';
export interface Slot {
  c: GrammaticalCase;
  g: Genus;
}

const N: GrammaticalCase = 'nominative';
const A: GrammaticalCase = 'accusative';
const D: GrammaticalCase = 'dative';
const G: GrammaticalCase = 'genitive';
const s = (c: GrammaticalCase, ...g: Genus[]): Slot[] => g.map((x) => ({ c, g: x }));

// ── determiners ──

/** Endings of der-words: dieser, jeder, welcher, … and the definite article by analogy. */
const DER_ENDINGS: Record<string, Slot[]> = {
  er: [...s(N, 'm'), ...s(D, 'f'), ...s(G, 'f', 'pl')],
  e: [...s(N, 'f', 'pl'), ...s(A, 'f', 'pl')],
  es: [...s(N, 'n'), ...s(A, 'n'), ...s(G, 'm', 'n')],
  en: [...s(A, 'm'), ...s(D, 'pl')],
  em: s(D, 'm', 'n'),
};

/** Endings of ein-words: ein, kein, mein, dein, sein, ihr, unser, euer. */
const EIN_ENDINGS: Record<string, Slot[]> = {
  '': [...s(N, 'm', 'n'), ...s(A, 'n')],
  e: [...s(N, 'f', 'pl'), ...s(A, 'f', 'pl')],
  en: [...s(A, 'm'), ...s(D, 'pl')],
  em: s(D, 'm', 'n'),
  er: [...s(D, 'f'), ...s(G, 'f', 'pl')],
  es: s(G, 'm', 'n'),
};

const ARTICLE_FORMS: Record<string, Slot[]> = {
  der: DER_ENDINGS.er!,
  die: DER_ENDINGS.e!,
  das: [...s(N, 'n'), ...s(A, 'n')],
  den: DER_ENDINGS.en!,
  dem: DER_ENDINGS.em!,
  des: s(G, 'm', 'n'),
};

interface DetStem {
  stem: string;
  lemma: string;
  ru: string;
  kind: string;
  ein: boolean;
}

const DET_STEMS: DetStem[] = [
  { stem: 'ein', lemma: 'ein', ru: 'неопределённый артикль; один', kind: 'unbestimmter Artikel', ein: true },
  { stem: 'kein', lemma: 'kein', ru: 'никакой, ни один; не', kind: 'Negationsartikel', ein: true },
  { stem: 'mein', lemma: 'mein', ru: 'мой', kind: 'Possessivartikel', ein: true },
  { stem: 'dein', lemma: 'dein', ru: 'твой', kind: 'Possessivartikel', ein: true },
  { stem: 'sein', lemma: 'sein', ru: 'его; свой', kind: 'Possessivartikel', ein: true },
  { stem: 'ihr', lemma: 'ihr', ru: 'её; их; свой', kind: 'Possessivartikel', ein: true },
  { stem: 'unser', lemma: 'unser', ru: 'наш', kind: 'Possessivartikel', ein: true },
  { stem: 'unsr', lemma: 'unser', ru: 'наш', kind: 'Possessivartikel', ein: true },
  { stem: 'euer', lemma: 'euer', ru: 'ваш', kind: 'Possessivartikel', ein: true },
  { stem: 'eur', lemma: 'euer', ru: 'ваш', kind: 'Possessivartikel', ein: true },
  { stem: 'dies', lemma: 'dieser', ru: 'этот', kind: 'Demonstrativartikel', ein: false },
  { stem: 'jed', lemma: 'jeder', ru: 'каждый', kind: 'Indefinitartikel', ein: false },
  { stem: 'jen', lemma: 'jener', ru: 'тот', kind: 'Demonstrativartikel', ein: false },
  { stem: 'welch', lemma: 'welcher', ru: 'какой, который', kind: 'Frageartikel', ein: false },
  { stem: 'manch', lemma: 'mancher', ru: 'некоторый, иной', kind: 'Indefinitartikel', ein: false },
  { stem: 'solch', lemma: 'solcher', ru: 'такой', kind: 'Demonstrativartikel', ein: false },
  { stem: 'all', lemma: 'alle', ru: 'все, весь', kind: 'Indefinitartikel', ein: false },
  { stem: 'beid', lemma: 'beide', ru: 'оба', kind: 'Indefinitartikel', ein: false },
];

export interface DeterminerInfo {
  lemma: string;
  ru: string;
  kind: string;
  /** Case/gender combinations this form can mark. */
  slots: Slot[];
}

/** Recognises articles and article-like words and returns the noun-phrase slots they allow. */
export function determinerInfo(word: string): DeterminerInfo | null {
  const lower = word.toLowerCase();
  const article = ARTICLE_FORMS[lower];
  if (article) return { lemma: 'der', ru: 'определённый артикль', kind: 'bestimmter Artikel', slots: article };
  for (const det of DET_STEMS) {
    if (!lower.startsWith(det.stem)) continue;
    const ending = lower.slice(det.stem.length);
    const slots = (det.ein ? EIN_ENDINGS : DER_ENDINGS)[ending];
    if (!slots || (!det.ein && ending === '')) continue;
    // "Ihr" capitalised inside a sentence is the polite form.
    if (det.stem === 'ihr' && word[0] === 'I') return { lemma: 'Ihr', ru: 'Ваш', kind: det.kind, slots };
    return { lemma: det.lemma, ru: det.ru, kind: det.kind, slots };
  }
  return null;
}

// ── prepositions ──

export interface PrepositionInfo {
  lemma: string;
  ru: string;
  cases: GrammaticalCase[];
  /** Contractions fix gender as well: "im" = in + dem. */
  genders?: Genus[];
  contraction?: string;
}

const PREPOSITIONS: Record<string, { ru: string; cases: GrammaticalCase[] }> = {
  durch: { ru: 'через, сквозь; посредством', cases: [A] },
  für: { ru: 'для, за', cases: [A] },
  gegen: { ru: 'против; около', cases: [A] },
  ohne: { ru: 'без', cases: [A] },
  um: { ru: 'вокруг; в (о времени); за', cases: [A] },
  bis: { ru: 'до', cases: [A] },
  entlang: { ru: 'вдоль', cases: [A] },
  aus: { ru: 'из', cases: [D] },
  außer: { ru: 'кроме', cases: [D] },
  bei: { ru: 'у, при, возле', cases: [D] },
  gegenüber: { ru: 'напротив; по отношению к', cases: [D] },
  mit: { ru: 'с', cases: [D] },
  nach: { ru: 'после; в, к (направление)', cases: [D] },
  seit: { ru: 'с (какого-то времени), уже', cases: [D] },
  von: { ru: 'от, из; о', cases: [D] },
  zu: { ru: 'к, на', cases: [D] },
  ab: { ru: 'с, от, начиная с', cases: [D] },
  laut: { ru: 'согласно', cases: [D, G] },
  dank: { ru: 'благодаря', cases: [D, G] },
  während: { ru: 'во время', cases: [G, D] },
  wegen: { ru: 'из-за', cases: [G, D] },
  trotz: { ru: 'несмотря на', cases: [G, D] },
  statt: { ru: 'вместо', cases: [G, D] },
  anstatt: { ru: 'вместо', cases: [G, D] },
  innerhalb: { ru: 'внутри, в течение', cases: [G] },
  außerhalb: { ru: 'вне, за пределами', cases: [G] },
  aufgrund: { ru: 'из-за, на основании', cases: [G] },
  an: { ru: 'у, на (вплотную); к', cases: [D, A] },
  auf: { ru: 'на', cases: [D, A] },
  hinter: { ru: 'за, позади', cases: [D, A] },
  in: { ru: 'в', cases: [D, A] },
  neben: { ru: 'рядом с', cases: [D, A] },
  über: { ru: 'над; через; о', cases: [D, A] },
  unter: { ru: 'под; среди', cases: [D, A] },
  vor: { ru: 'перед; до; назад (о времени)', cases: [D, A] },
  zwischen: { ru: 'между', cases: [D, A] },
};

const CONTRACTIONS: Record<string, { prep: string; article: string; c: GrammaticalCase; genders: Genus[] }> = {
  im: { prep: 'in', article: 'dem', c: D, genders: ['m', 'n'] },
  am: { prep: 'an', article: 'dem', c: D, genders: ['m', 'n'] },
  zum: { prep: 'zu', article: 'dem', c: D, genders: ['m', 'n'] },
  zur: { prep: 'zu', article: 'der', c: D, genders: ['f'] },
  vom: { prep: 'von', article: 'dem', c: D, genders: ['m', 'n'] },
  beim: { prep: 'bei', article: 'dem', c: D, genders: ['m', 'n'] },
  ins: { prep: 'in', article: 'das', c: A, genders: ['n'] },
  ans: { prep: 'an', article: 'das', c: A, genders: ['n'] },
  aufs: { prep: 'auf', article: 'das', c: A, genders: ['n'] },
  fürs: { prep: 'für', article: 'das', c: A, genders: ['n'] },
  ums: { prep: 'um', article: 'das', c: A, genders: ['n'] },
  durchs: { prep: 'durch', article: 'das', c: A, genders: ['n'] },
  übers: { prep: 'über', article: 'das', c: A, genders: ['n'] },
  unterm: { prep: 'unter', article: 'dem', c: D, genders: ['m', 'n'] },
  hinterm: { prep: 'hinter', article: 'dem', c: D, genders: ['m', 'n'] },
  vorm: { prep: 'vor', article: 'dem', c: D, genders: ['m', 'n'] },
};

export function prepositionInfo(word: string): PrepositionInfo | null {
  const lower = word.toLowerCase();
  const contraction = CONTRACTIONS[lower];
  if (contraction) {
    const base = PREPOSITIONS[contraction.prep]!;
    return { lemma: contraction.prep, ru: base.ru, cases: [contraction.c], genders: contraction.genders, contraction: `${contraction.prep} + ${contraction.article}` };
  }
  const prep = PREPOSITIONS[lower];
  return prep ? { lemma: lower, ru: prep.ru, cases: prep.cases } : null;
}

// ── personal pronouns ──

export interface PronounInfo {
  lemma: string;
  ru: string;
  kind: string;
  cases: GrammaticalCase[];
  person?: Person;
  number?: GrammaticalNumber;
}

const PRONOUNS: Record<string, PronounInfo> = {
  ich: { lemma: 'ich', ru: 'я', kind: 'Personalpronomen', cases: [N], person: 1, number: 'singular' },
  mich: { lemma: 'ich', ru: 'меня; себя', kind: 'Personalpronomen', cases: [A], person: 1, number: 'singular' },
  mir: { lemma: 'ich', ru: 'мне; себе', kind: 'Personalpronomen', cases: [D], person: 1, number: 'singular' },
  du: { lemma: 'du', ru: 'ты', kind: 'Personalpronomen', cases: [N], person: 2, number: 'singular' },
  dich: { lemma: 'du', ru: 'тебя; себя', kind: 'Personalpronomen', cases: [A], person: 2, number: 'singular' },
  dir: { lemma: 'du', ru: 'тебе; себе', kind: 'Personalpronomen', cases: [D], person: 2, number: 'singular' },
  er: { lemma: 'er', ru: 'он', kind: 'Personalpronomen', cases: [N], person: 3, number: 'singular' },
  ihn: { lemma: 'er', ru: 'его', kind: 'Personalpronomen', cases: [A], person: 3, number: 'singular' },
  ihm: { lemma: 'er', ru: 'ему', kind: 'Personalpronomen', cases: [D], person: 3, number: 'singular' },
  sie: { lemma: 'sie', ru: 'она; они; её; их', kind: 'Personalpronomen', cases: [N, A], person: 3 },
  es: { lemma: 'es', ru: 'оно; это', kind: 'Personalpronomen', cases: [N, A], person: 3, number: 'singular' },
  "'s": { lemma: 'es', ru: 'оно; это', kind: 'Personalpronomen (verkürzt)', cases: [N, A], person: 3, number: 'singular' },
  '’s': { lemma: 'es', ru: 'оно; это', kind: 'Personalpronomen (verkürzt)', cases: [N, A], person: 3, number: 'singular' },
  wir: { lemma: 'wir', ru: 'мы', kind: 'Personalpronomen', cases: [N], person: 1, number: 'plural' },
  uns: { lemma: 'wir', ru: 'нас; нам; себя', kind: 'Personalpronomen', cases: [A, D], person: 1, number: 'plural' },
  euch: { lemma: 'ihr', ru: 'вас; вам; себя', kind: 'Personalpronomen', cases: [A, D], person: 2, number: 'plural' },
  ihnen: { lemma: 'sie', ru: 'им', kind: 'Personalpronomen', cases: [D], person: 3, number: 'plural' },
  man: { lemma: 'man', ru: 'безличное подлежащее: «говорят», «можно»', kind: 'Indefinitpronomen', cases: [N], person: 3, number: 'singular' },
  sich: { lemma: 'sich', ru: 'себя, себе; -ся', kind: 'Reflexivpronomen', cases: [A, D], person: 3 },
  wer: { lemma: 'wer', ru: 'кто', kind: 'Fragepronomen', cases: [N], person: 3, number: 'singular' },
  wen: { lemma: 'wer', ru: 'кого', kind: 'Fragepronomen', cases: [A] },
  wem: { lemma: 'wer', ru: 'кому', kind: 'Fragepronomen', cases: [D] },
  wessen: { lemma: 'wer', ru: 'чей', kind: 'Fragepronomen', cases: [G] },
  jemand: { lemma: 'jemand', ru: 'кто-то, кто-нибудь', kind: 'Indefinitpronomen', cases: [N, A], person: 3, number: 'singular' },
  niemand: { lemma: 'niemand', ru: 'никто', kind: 'Indefinitpronomen', cases: [N, A], person: 3, number: 'singular' },
  nichts: { lemma: 'nichts', ru: 'ничего, ничто', kind: 'Indefinitpronomen', cases: [N, A] },
  etwas: { lemma: 'etwas', ru: 'что-то, что-нибудь; немного', kind: 'Indefinitpronomen', cases: [N, A] },
};

/** Polite forms are capitalised inside a sentence. */
const POLITE: Record<string, PronounInfo> = {
  Sie: { lemma: 'Sie', ru: 'Вы; Вас', kind: 'Personalpronomen (Höflichkeitsform)', cases: [N, A], person: 3, number: 'plural' },
  Ihnen: { lemma: 'Sie', ru: 'Вам', kind: 'Personalpronomen (Höflichkeitsform)', cases: [D], person: 3, number: 'plural' },
};

export function pronounInfo(word: string, sentenceStart: boolean): PronounInfo | null {
  if (!sentenceStart && POLITE[word]) return POLITE[word]!;
  return PRONOUNS[word.toLowerCase()] ?? null;
}

// ── conjunctions and particles ──

export interface FunctionWordInfo {
  pos: PartOfSpeech;
  lemma: string;
  ru: string;
  kind: string;
}

const COORDINATING: Record<string, string> = { und: 'и', oder: 'или', aber: 'но', denn: 'потому что; же', sondern: 'а, но (после отрицания)' };
const SUBORDINATING: Record<string, string> = {
  dass: 'что',
  weil: 'потому что',
  wenn: 'если; когда',
  ob: 'ли',
  obwohl: 'хотя',
  bevor: 'прежде чем',
  nachdem: 'после того как',
  damit: 'чтобы',
  falls: 'в случае если',
  sobald: 'как только',
  solange: 'пока',
  indem: 'тем что, посредством того что',
  seitdem: 'с тех пор как',
  ehe: 'прежде чем',
  sodass: 'так что',
};
const PARTICLES: Record<string, { ru: string; kind: string; pos?: PartOfSpeech }> = {
  nicht: { ru: 'не', kind: 'Negationspartikel' },
  ja: { ru: 'да; ведь, же', kind: 'Antwort- und Modalpartikel' },
  nein: { ru: 'нет', kind: 'Antwortpartikel' },
  doch: { ru: 'же, всё-таки; нет (в ответ на отрицание)', kind: 'Modalpartikel' },
  mal: { ru: '-ка (смягчает просьбу); раз', kind: 'Modalpartikel' },
  halt: { ru: 'просто, ну (разг.)', kind: 'Modalpartikel' },
  eben: { ru: 'именно; только что; просто', kind: 'Modalpartikel' },
  bitte: { ru: 'пожалуйста', kind: 'Höflichkeitspartikel' },
  danke: { ru: 'спасибо', kind: 'Höflichkeitspartikel' },
  ne: { ru: 'разг. вместо «eine»', kind: 'umgangssprachlich für „eine“', pos: 'determiner' },
  nen: { ru: 'разг. вместо «einen»', kind: 'umgangssprachlich für „einen“', pos: 'determiner' },
  nix: { ru: 'ничего (разг.)', kind: 'umgangssprachlich für „nichts“', pos: 'pronoun' },
};

export function functionWordInfo(word: string): FunctionWordInfo | null {
  const lower = word.toLowerCase();
  if (COORDINATING[lower]) return { pos: 'conjunction', lemma: lower, ru: COORDINATING[lower]!, kind: 'nebenordnende Konjunktion' };
  if (SUBORDINATING[lower]) return { pos: 'conjunction', lemma: lower, ru: SUBORDINATING[lower]!, kind: 'unterordnende Konjunktion (Verb am Satzende)' };
  const particle = PARTICLES[lower];
  if (particle) return { pos: particle.pos ?? 'particle', lemma: lower, ru: particle.ru, kind: particle.kind };
  return null;
}

export const SOFT_BOUNDARIES = new Set(Object.keys(COORDINATING));
export const SUBORDINATORS = new Set([...Object.keys(SUBORDINATING), 'als', 'während', 'da', 'bis', 'seit', 'wie', 'wo', 'was', 'wer', 'warum', 'wann', 'wohin', 'woher', 'weshalb']);

// ── verbs ──

export const AUXILIARIES = new Set(['haben', 'sein', 'werden']);
export const MODALS = new Set(['können', 'müssen', 'dürfen', 'sollen', 'wollen', 'mögen', 'möchten']);
export const COPULAS = new Set(['sein', 'werden', 'bleiben', 'heißen']);
/** Verbs whose object stands in the dative. */
export const DATIVE_VERBS = new Set(['helfen', 'danken', 'gehören', 'gefallen', 'antworten', 'glauben', 'folgen', 'passen', 'schmecken', 'gratulieren', 'zuhören', 'vertrauen', 'begegnen', 'fehlen', 'gelingen', 'schaden', 'raten', 'widersprechen', 'zustimmen', 'dienen', 'drohen', 'nützen']);
/** Verbs of directed motion: with two-way prepositions they take the accusative. */
export const MOTION_VERBS = new Set(['gehen', 'fahren', 'kommen', 'laufen', 'fliegen', 'legen', 'stellen', 'setzen', 'bringen', 'ziehen', 'steigen', 'werfen', 'rennen', 'springen', 'reisen', 'schicken', 'tragen', 'stecken', 'packen', 'hängen', 'fallen', 'treten', 'einsteigen', 'umziehen']);

/** Prefixes that can detach. Whether a verb really has one is confirmed against the dictionary. */
export const SEPARABLE_PREFIXES = [
  'auseinander', 'gegenüber', 'zusammen', 'entgegen', 'herunter', 'hinunter', 'herüber', 'hinüber', 'vorüber', 'zurecht',
  'zurück', 'weiter', 'wieder', 'vorbei', 'voraus', 'vorher', 'herein', 'heraus', 'herauf', 'hinein', 'hinaus', 'hinauf', 'hervor', 'kennen', 'runter', 'rüber',
  'herum', 'hinzu', 'hinweg', 'empor', 'davon', 'dabei', 'daher', 'dahin', 'durch', 'unter', 'nieder', 'voran', 'statt', 'übrig', 'rein', 'raus', 'rauf', 'rum',
  'dazu', 'fest', 'fort', 'heim', 'hoch', 'nach', 'teil', 'über', 'frei', 'hin', 'her', 'los', 'mit', 'vor', 'weg', 'auf', 'aus', 'bei', 'ein', 'dar',
  'ab', 'an', 'um', 'zu', 'da',
];
export const SEPARABLE_SET = new Set(SEPARABLE_PREFIXES);
export const INSEPARABLE_PREFIXES = ['miss', 'emp', 'ent', 'ver', 'zer', 'be', 'er', 'ge'];

// Shared domain types. Everything that crosses a module or process boundary is declared here.

// ───────────────────────────── Subtitles ─────────────────────────────

/** One subtitle segment with its position on the video timeline. */
export interface Cue {
  /** Position in the track, starting at 0. */
  index: number;
  /** Start time in seconds. */
  start: number;
  /** End time in seconds. */
  end: number;
  /** Plain text: tags removed, whitespace collapsed to single spaces. */
  text: string;
}

export type TrackKind = 'manual' | 'asr' | 'unknown';

export interface TrackInfo {
  /** Adapter-specific identifier, unique within the page. */
  id: string;
  /** BCP 47 language tag as reported by the site; may be empty. */
  language: string;
  label: string;
  kind: TrackKind;
  isGerman: boolean;
}

export type AdapterStatusCode =
  | 'searching' // looking for a video or its subtitle tracks
  | 'ready' // German cues are available
  | 'no-video'
  | 'no-subtitles' // the video has no subtitle tracks at all
  | 'no-german' // tracks exist, none of them is German
  | 'waiting-captions' // German track chosen, waiting for the site to deliver cues
  | 'blocked'; // subtitles exist but cannot be read (cross-origin, DRM, …)

export interface AdapterStatus {
  code: AdapterStatusCode;
  /** Human-readable detail for the diagnostics panel. */
  detail?: string;
}

// ───────────────────────────── Tokens ─────────────────────────────

export type TokenKind = 'word' | 'number' | 'punct';

export interface Token {
  /** Index among all tokens of the sentence (spaces are not tokens). */
  index: number;
  text: string;
  /** Character offsets in the source string, end exclusive. */
  start: number;
  end: number;
  kind: TokenKind;
  /** True when the source string has whitespace right before this token. */
  spaceBefore: boolean;
}

// ───────────────────────────── Linguistics ─────────────────────────────

/** How much the engine trusts a piece of information. */
export type Certainty = 'certain' | 'likely' | 'uncertain';

/** Where a piece of information comes from. */
export type InfoSource = 'builtin' | 'dictionary' | 'rules' | 'parser' | 'llm' | 'mt';

/** A value together with its reliability. The UI marks everything that is not `certain`. */
export interface Marked<T> {
  value: T;
  certainty: Certainty;
  source: InfoSource;
}

export type PartOfSpeech =
  | 'noun'
  | 'proper-noun'
  | 'verb'
  | 'adjective'
  | 'adverb'
  | 'pronoun'
  | 'determiner'
  | 'preposition'
  | 'conjunction'
  | 'particle'
  | 'numeral'
  | 'interjection'
  | 'unknown';

export type Gender = 'm' | 'f' | 'n';
export type GrammaticalCase = 'nominative' | 'accusative' | 'dative' | 'genitive';
export type GrammaticalNumber = 'singular' | 'plural';
export type Person = 1 | 2 | 3;
export type Tense = 'present' | 'preterite' | 'perfect' | 'pluperfect' | 'future1' | 'future2';
export type Mood = 'indicative' | 'subjunctive1' | 'subjunctive2' | 'imperative';
export type Voice = 'active' | 'passive';
export type VerbFormKind = 'finite' | 'infinitive' | 'zu-infinitive' | 'participle1' | 'participle2';
export type AdjectiveDegree = 'positive' | 'comparative' | 'superlative';
export type Auxiliary = 'haben' | 'sein';

export interface TranslationInfo {
  /** Meaning chosen for this sentence. Absent when nothing could be determined. */
  contextual?: Marked<string>;
  /** Dictionary senses in dictionary order (Russian). */
  senses: string[];
}

export interface ExampleSentence {
  de: string;
  ru?: string;
}

/** Generic labelled feature, used for parts of speech without a dedicated structure. */
export interface GrammarFeature {
  /** Stable key, e.g. "case", "governs", "person". */
  key: string;
  value: Marked<string>;
}

/** Another possible reading of the same word form. */
export interface AlternativeReading {
  pos: PartOfSpeech;
  lemma: string;
  /** Short Russian gloss if the dictionary has one. */
  gloss?: string;
  /** Compact grammatical description, e.g. "Akkusativ Plural". */
  note?: string;
}

interface WordAnalysisBase {
  /** Word exactly as it appears in the sentence. */
  surface: string;
  tokenIndex: number;
  pos: Marked<PartOfSpeech>;
  lemma: Marked<string>;
  translation: TranslationInfo;
  /** German definitions. */
  definitions?: string[];
  synonyms?: string[];
  /** Usage labels such as "umgangssprachlich". */
  usage?: string[];
  example?: ExampleSentence;
  alternatives?: AlternativeReading[];
  /** Free-form remarks produced by the engine, e.g. "trennbares Präfix zu aufstehen". */
  notes?: string[];
}

export interface NounDeclension {
  singular: Partial<Record<GrammaticalCase, string[]>>;
  plural: Partial<Record<GrammaticalCase, string[]>>;
}

export interface NounAnalysis extends WordAnalysisBase {
  kind: 'noun';
  gender?: Marked<Gender[]>;
  /** Nominative singular. */
  singular?: string;
  /** Nominative plural forms; empty array means the noun has no plural. */
  plural?: Marked<string[]>;
  genitiveSingular?: string[];
  case?: Marked<GrammaticalCase[]>;
  number?: Marked<GrammaticalNumber>;
  declension?: NounDeclension;
  /** Parts of a compound that is not in the dictionary as a whole. */
  compoundParts?: string[];
}

export interface PresentConjugation {
  ich: string;
  du: string;
  er: string;
  wir: string;
  ihr: string;
  sie: string;
}

export interface SeparableInfo {
  prefix: string;
  /** True when prefix and stem are written apart in this sentence. */
  separated: boolean;
  /** Token index of the detached prefix, when separated. */
  prefixTokenIndex?: number;
  /** Token index of the finite verb part, when separated. */
  verbTokenIndex?: number;
}

export interface VerbFormInSentence {
  kind: VerbFormKind;
  tense?: Marked<Tense>;
  mood?: Marked<Mood>;
  voice?: Marked<Voice>;
  person?: Marked<Person[]>;
  number?: Marked<GrammaticalNumber>;
}

export interface VerbAnalysis extends WordAnalysisBase {
  kind: 'verb';
  infinitive: string;
  partizip2?: string;
  /** 1st/3rd person singular Präteritum. */
  praeteritum?: string;
  present?: PresentConjugation;
  auxiliary?: Marked<Auxiliary[]>;
  separable?: SeparableInfo;
  inseparablePrefix?: string;
  reflexive?: Marked<boolean>;
  /** Role of this token: full verb, auxiliary of a compound tense, modal, or detached prefix. */
  role: 'main' | 'auxiliary' | 'modal' | 'prefix';
  form: VerbFormInSentence;
}

export interface AdjectiveAnalysis extends WordAnalysisBase {
  kind: 'adjective';
  comparative?: string;
  superlative?: string;
  degree?: Marked<AdjectiveDegree>;
  case?: Marked<GrammaticalCase[]>;
  gender?: Marked<Gender[]>;
  number?: Marked<GrammaticalNumber>;
  /** Declined (attributive) or bare (predicative/adverbial) use. */
  usage2?: 'attributive' | 'predicative';
}

export interface OtherAnalysis extends WordAnalysisBase {
  kind: 'other';
  features: GrammarFeature[];
}

export type WordAnalysis = NounAnalysis | VerbAnalysis | AdjectiveAnalysis | OtherAnalysis;

export type AnalysisEngine = 'browser' | 'spacy';

export interface SentenceAnalysis {
  /** One entry per token; null for punctuation and numbers. */
  words: (WordAnalysis | null)[];
  engine: AnalysisEngine;
  ms: number;
}

// ───────────────────────────── Translation ─────────────────────────────

export type ProviderId = 'opus-browser' | 'local-service' | 'ollama';

export type Priority = 0 | 1 | 2;

/** A piece of German text to translate, with the dialogue around it. */
export interface TranslateItem {
  /** Client-side key; echoed back with the result. */
  key: string;
  text: string;
  /** Preceding subtitle lines, oldest first. Context only, never translated. */
  before: string[];
  /** Following subtitle lines, if already known. Context only. */
  after: string[];
  /** 0 = on screen now, 1 = coming up next, 2 = background preload. */
  priority: Priority;
}

export interface TranslationResult {
  key: string;
  text: string;
  provider: ProviderId;
  cached: boolean;
  /** Provider latency in milliseconds; 0 for cache hits. */
  ms: number;
  /** True for a fast first answer that a better translation will replace. */
  provisional?: boolean;
}

export type ErrorCode =
  | 'no-provider' // nothing is configured or reachable
  | 'unreachable' // local endpoint did not answer
  | 'forbidden' // endpoint rejected the extension origin
  | 'model-missing' // requested model is not installed
  | 'model-load' // model files failed to load
  | 'bad-response' // endpoint answered with something unusable
  | 'timeout'
  | 'cancelled'
  | 'internal';

export interface MitlesenError {
  code: ErrorCode;
  message: string;
}

export interface ProviderStatus {
  id: ProviderId;
  state: 'unknown' | 'ready' | 'loading' | 'unavailable' | 'error';
  /** Model name, device, or the reason for unavailability. */
  detail?: string;
  /** 0..1 while the model is loading. */
  progress?: number;
  error?: MitlesenError;
  checkedAt?: number;
}

export interface LatencyStats {
  count: number;
  avg: number;
  median: number;
  p95: number;
}

export interface ProviderMetrics {
  id: ProviderId;
  requests: number;
  errors: number;
  latency: LatencyStats;
  /** Milliseconds from first use until the model answered its first request. */
  initMs?: number;
}

export interface Diagnostics {
  version: string;
  browser: string;
  offscreenApi: boolean;
  activeProvider: ProviderId | null;
  providers: ProviderStatus[];
  metrics: ProviderMetrics[];
  cache: { translations: number; analyses: number; hits: number; misses: number; approxBytes: number };
  queue: { waiting: number; inFlight: number };
  dictionary: { entries: number; version: string } | null;
  analysisEngine: AnalysisEngine;
  analysisLatency: LatencyStats;
  lastError?: MitlesenError & { at: number };
}

// Grammar service of the background worker: runs the browser analyser, optionally refined by
// the dependency parser of the local service, and caches results per sentence.
import { ANALYZER_VERSION, analyzeSentence, type ParseToken } from '../../nlp/analyzer.ts';
import { ShardDictionary, type Dictionary } from '../../nlp/dictionary.ts';
import { hashString } from '../../shared/text.ts';
import type { AnalysisEngine, SentenceAnalysis } from '../../shared/types';
import type { CacheStore } from '../cache/store';
import type { LatencyWindow } from '../translation/metrics';

const PARSE_TIMEOUT_MS = 2_500;

export interface AnalysisDeps {
  cache: CacheStore<SentenceAnalysis>;
  latency: LatencyWindow;
  /** Endpoint of the local service when its parser is ready, else null. */
  parserEndpoint: () => string | null;
  dictionary?: Dictionary;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Validates cached analyses; anything else is treated as corrupted and dropped. */
export function isSentenceAnalysis(value: unknown): value is SentenceAnalysis {
  if (!isObject(value) || !Array.isArray(value.words) || typeof value.ms !== 'number') return false;
  if (value.engine !== 'browser' && value.engine !== 'spacy') return false;
  return value.words.every((w) => w === null || (isObject(w) && typeof w.kind === 'string' && typeof w.surface === 'string' && isObject(w.lemma) && isObject(w.translation)));
}

/** Validates the parser response of the local service. */
export function parseTokens(value: unknown): ParseToken[] | null {
  if (!isObject(value) || !Array.isArray(value.tokens)) return null;
  const tokens: ParseToken[] = [];
  for (const t of value.tokens) {
    if (!isObject(t) || typeof t.start !== 'number' || typeof t.end !== 'number' || typeof t.pos !== 'string') return null;
    const morph: Record<string, string> = {};
    if (isObject(t.morph)) for (const [k, v] of Object.entries(t.morph)) if (typeof v === 'string') morph[k] = v;
    tokens.push({
      start: t.start,
      end: t.end,
      pos: t.pos,
      lemma: typeof t.lemma === 'string' ? t.lemma : '',
      dep: typeof t.dep === 'string' ? t.dep : '',
      head: typeof t.head === 'number' ? t.head : -1,
      morph,
    });
  }
  return tokens;
}

export class AnalysisService {
  private readonly dict: Dictionary;
  private readonly deps: AnalysisDeps;
  private readonly inFlight = new Map<string, Promise<SentenceAnalysis>>();

  constructor(deps: AnalysisDeps) {
    this.deps = deps;
    this.dict =
      deps.dictionary ??
      new ShardDictionary(async (path) => {
        const res = await fetch(chrome.runtime.getURL(`dict/${path}`));
        if (!res.ok) throw new Error(`dictionary shard ${path}: HTTP ${res.status}`);
        return res.json();
      });
  }

  engine(): AnalysisEngine {
    return this.deps.parserEndpoint() ? 'spacy' : 'browser';
  }

  async dictionaryInfo(): Promise<{ entries: number; version: string } | null> {
    const meta = await this.dict.meta();
    return meta ? { entries: meta.entries, version: meta.version } : null;
  }

  private async parse(endpoint: string, sentence: string): Promise<ParseToken[] | null> {
    try {
      const res = await fetch(`${endpoint}/analyze`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: sentence }),
        signal: AbortSignal.timeout(PARSE_TIMEOUT_MS),
      });
      if (!res.ok) return null;
      return parseTokens(await res.json());
    } catch {
      return null; // the browser analyser alone still gives a full answer
    }
  }

  analyze(sentence: string, translation?: string): Promise<SentenceAnalysis> {
    const endpoint = this.deps.parserEndpoint();
    const key = `a${ANALYZER_VERSION}|${endpoint ? 'spacy' : 'browser'}|${hashString(sentence)}|${translation ? hashString(translation) : ''}`;
    const running = this.inFlight.get(key);
    if (running) return running;
    const promise = (async (): Promise<SentenceAnalysis> => {
      const cached = await this.deps.cache.get(key);
      if (cached) return cached;
      const started = performance.now();
      const parse = endpoint ? await this.parse(endpoint, sentence) : null;
      const words = await analyzeSentence(sentence, this.dict, { translation, parse: parse ?? undefined });
      const ms = Math.round(performance.now() - started);
      this.deps.latency.add(ms);
      const result: SentenceAnalysis = { words, engine: parse ? 'spacy' : 'browser', ms };
      // A parse that failed is not cached under the parser key, so the next request tries again.
      if (!endpoint || parse) void this.deps.cache.set(key, result);
      return result;
    })().finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, promise);
    return promise;
  }
}

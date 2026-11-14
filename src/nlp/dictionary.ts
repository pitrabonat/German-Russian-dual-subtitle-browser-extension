// Read access to the compiled dictionary (data/dict, see data-pipeline/build-dict.mjs).
// Shards are loaded on demand and kept in a small LRU, so memory stays bounded.

export type PosCode = 'n' | 'name' | 'v' | 'a' | 'adv' | 'prep' | 'conj' | 'pron' | 'det' | 'num' | 'part' | 'intj';

export interface DictEntry {
  /** Lemma. */
  w: string;
  p: PosCode;
  /** Russian senses in dictionary order. */
  ru?: string[];
  /** True when `ru` was produced by machine translation of the lemma. */
  mt?: 1;
  /** German definitions. */
  de?: string[];
  /** Example: German sentence and, if known, its Russian translation. */
  ex?: [string] | [string, string];
  syn?: string[];
  /** Usage labels. */
  tg?: string[];
  // nouns
  /** Genders as letters m/f/n; "p" for plural-only nouns. */
  g?: string;
  /** Genitive singular forms. */
  gs?: string[];
  /** Nominative plural forms. */
  pl?: string[];
  /** Accusative singular when it differs from the lemma (weak masculine nouns). */
  as?: string;
  // verbs
  /** Present indicative: ich, du, er, wir, ihr, sie. */
  vp?: string[];
  /** Präteritum, 1st/3rd person singular. */
  vt?: string;
  /** Partizip II. */
  pp?: string;
  /** Auxiliaries: "h", "s", "hs", "sh". */
  aux?: string;
  /** Separable prefix. */
  sep?: string;
  /** 1 = reflexive in every sense, 2 = reflexive in some senses. */
  refl?: 1 | 2;
  // adjectives and adverbs
  cmp?: string;
  sup?: string;
}

export interface DictMeta {
  schema: number;
  version: string;
  entries: number;
  formShards: number;
  entryShardSize: number;
}

/** One reading of a word form: the lemma entry and compact grammar codes. */
export interface FormHit {
  id: number;
  /** For example ["ip1s", "k11s"] for a verb, ["N0d"] for a noun, ["A0"] for an adjective. */
  codes: string[];
}

export interface Dictionary {
  /** Readings of an exact form (case-sensitive). */
  lookup(form: string): Promise<FormHit[]>;
  entry(id: number): Promise<DictEntry | null>;
  meta(): Promise<DictMeta | null>;
}

/** Loads a shard by its path relative to the dictionary root, e.g. "f/17.json". */
export type ShardLoader = (path: string) => Promise<unknown>;

function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

class Lru<V> {
  private readonly map = new Map<string, V>();
  private readonly capacity: number;
  constructor(capacity: number) {
    this.capacity = capacity;
  }
  get(key: string): V | undefined {
    const value = this.map.get(key);
    if (value !== undefined) {
      this.map.delete(key);
      this.map.set(key, value);
    }
    return value;
  }
  set(key: string, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }
}

export class ShardDictionary implements Dictionary {
  private metaPromise: Promise<DictMeta | null> | null = null;
  private readonly formShards = new Lru<Promise<Record<string, string>>>(96);
  private readonly entryShards = new Lru<Promise<DictEntry[]>>(96);

  private readonly load: ShardLoader;

  constructor(load: ShardLoader) {
    this.load = load;
  }

  meta(): Promise<DictMeta | null> {
    this.metaPromise ??= this.load('meta.json')
      .then((raw) => {
        const m = raw as Partial<DictMeta> | null;
        return m && typeof m.entries === 'number' && typeof m.formShards === 'number' && typeof m.entryShardSize === 'number' ? (m as DictMeta) : null;
      })
      .catch(() => null);
    return this.metaPromise;
  }

  private shard<T>(cache: Lru<Promise<T>>, path: string, fallback: T): Promise<T> {
    let promise = cache.get(path);
    if (!promise) {
      promise = this.load(path).then(
        (raw) => (raw && typeof raw === 'object' ? (raw as T) : fallback),
        () => fallback,
      );
      cache.set(path, promise);
    }
    return promise;
  }

  async lookup(form: string): Promise<FormHit[]> {
    const meta = await this.meta();
    if (!meta || form.length === 0 || form.length > 60) return [];
    const shard = await this.shard<Record<string, string>>(this.formShards, `f/${fnv1a(form.toLowerCase()) % meta.formShards}.json`, {});
    const packed = Object.prototype.hasOwnProperty.call(shard, form) ? shard[form] : undefined;
    if (typeof packed !== 'string') return [];
    const hits: FormHit[] = [];
    for (const part of packed.split(';')) {
      const colon = part.indexOf(':');
      const id = Number(part.slice(0, colon));
      if (colon > 0 && Number.isInteger(id)) hits.push({ id, codes: part.slice(colon + 1).split(',') });
    }
    return hits;
  }

  async entry(id: number): Promise<DictEntry | null> {
    const meta = await this.meta();
    if (!meta || id < 0 || id >= meta.entries) return null;
    const shard = await this.shard<DictEntry[]>(this.entryShards, `e/${Math.floor(id / meta.entryShardSize)}.json`, []);
    return shard[id % meta.entryShardSize] ?? null;
  }
}

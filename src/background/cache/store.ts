// Persistent cache on IndexedDB with an in-memory LRU in front of it.
//
// Design rules:
//  - The cache is disposable. Any failure (quota, blocked upgrade, corrupted record) degrades
//    to memory-only operation and never reaches the caller as an exception.
//  - Keys are built by the caller and already contain a schema version, the provider and the
//    model, so a change of model or prompt never returns stale data.
//  - Every record is validated on read; records that fail validation are deleted.
//  - Size is bounded by entry count, age is bounded by a TTL.

export const DB_NAME = 'mitlesen-cache';
/** Bump to drop and recreate all stores. */
export const DB_VERSION = 1;

export const STORES = ['translations', 'analyses', 'meta'] as const;
export type StoreName = (typeof STORES)[number];

interface CacheRecord {
  /** key */
  k: string;
  /** value */
  v: unknown;
  /** created (ms since epoch) */
  c: number;
  /** last access (ms since epoch) */
  a: number;
  /** approximate size in bytes */
  s: number;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
  });
}

/** Opens the database; resolves to null when IndexedDB is unusable. */
export function openCacheDb(factory: IDBFactory | undefined = globalThis.indexedDB): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase | null>((resolve) => {
    if (!factory) {
      resolve(null);
      return;
    }
    let request: IDBOpenDBRequest;
    try {
      request = factory.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const name of Array.from(db.objectStoreNames)) db.deleteObjectStore(name);
      for (const name of STORES) {
        const store = db.createObjectStore(name, { keyPath: 'k' });
        store.createIndex('a', 'a');
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      // Another context wants to upgrade: let go, and reopen lazily on the next call.
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
  return dbPromise;
}

/** Test hook: forget the cached connection. */
export function resetCacheDbForTests(): void {
  dbPromise = null;
}

export interface CacheOptions<T> {
  store: StoreName;
  /** Rejects corrupted or outdated records. */
  validate: (value: unknown) => value is T;
  maxEntries: number;
  ttlMs: number;
  /** Size of the in-memory LRU. */
  memoryEntries: number;
  now?: () => number;
  db?: () => Promise<IDBDatabase | null>;
}

export interface CacheStats {
  hits: number;
  misses: number;
  writes: number;
  failures: number;
}

export class CacheStore<T> {
  private readonly memory = new Map<string, T>();
  private readonly opts: Required<CacheOptions<T>>;
  private writesSincePrune = 0;
  readonly stats: CacheStats = { hits: 0, misses: 0, writes: 0, failures: 0 };

  constructor(options: CacheOptions<T>) {
    this.opts = { now: Date.now, db: () => openCacheDb(), ...options };
  }

  private remember(key: string, value: T): void {
    this.memory.delete(key);
    this.memory.set(key, value);
    if (this.memory.size > this.opts.memoryEntries) {
      const oldest = this.memory.keys().next().value;
      if (oldest !== undefined) this.memory.delete(oldest);
    }
  }

  async get(key: string): Promise<T | undefined> {
    const cached = this.memory.get(key);
    if (cached !== undefined) {
      this.remember(key, cached);
      this.stats.hits++;
      return cached;
    }
    try {
      const db = await this.opts.db();
      if (!db) {
        this.stats.misses++;
        return undefined;
      }
      const tx = db.transaction(this.opts.store, 'readwrite');
      const store = tx.objectStore(this.opts.store);
      const record = (await requestToPromise(store.get(key))) as CacheRecord | undefined;
      const now = this.opts.now();
      if (!record) {
        this.stats.misses++;
        return undefined;
      }
      const expired = now - record.c > this.opts.ttlMs;
      if (expired || !this.opts.validate(record.v)) {
        store.delete(key);
        this.stats.misses++;
        return undefined;
      }
      // Refresh the access time at most once per hour to keep reads cheap.
      if (now - record.a > 3_600_000) store.put({ ...record, a: now });
      this.remember(key, record.v);
      this.stats.hits++;
      return record.v;
    } catch {
      this.stats.failures++;
      this.stats.misses++;
      return undefined;
    }
  }

  async set(key: string, value: T): Promise<void> {
    this.remember(key, value);
    this.stats.writes++;
    try {
      const db = await this.opts.db();
      if (!db) return;
      const now = this.opts.now();
      const record: CacheRecord = { k: key, v: value, c: now, a: now, s: approximateSize(value) + key.length * 2 };
      const tx = db.transaction(this.opts.store, 'readwrite');
      tx.objectStore(this.opts.store).put(record);
      await transactionDone(tx);
      if (++this.writesSincePrune >= 200) {
        this.writesSincePrune = 0;
        void this.prune();
      }
    } catch {
      this.stats.failures++;
    }
  }

  /** Removes expired records and, beyond `maxEntries`, the least recently used ones. */
  async prune(): Promise<number> {
    try {
      const db = await this.opts.db();
      if (!db) return 0;
      const tx = db.transaction(this.opts.store, 'readwrite');
      const store = tx.objectStore(this.opts.store);
      const total = await requestToPromise(store.count());
      const now = this.opts.now();
      let excess = Math.max(0, total - this.opts.maxEntries);
      let removed = 0;
      await new Promise<void>((resolve, reject) => {
        const cursorRequest = store.index('a').openCursor();
        cursorRequest.onerror = () => reject(cursorRequest.error);
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor) {
            resolve();
            return;
          }
          const record = cursor.value as CacheRecord;
          const expired = now - record.c > this.opts.ttlMs;
          if (expired || excess > 0) {
            cursor.delete();
            this.memory.delete(record.k);
            removed++;
            if (!expired || excess > 0) excess = Math.max(0, excess - 1);
          }
          cursor.continue();
        };
      });
      await transactionDone(tx);
      return removed;
    } catch {
      this.stats.failures++;
      return 0;
    }
  }

  async clear(): Promise<void> {
    this.memory.clear();
    try {
      const db = await this.opts.db();
      if (!db) return;
      const tx = db.transaction(this.opts.store, 'readwrite');
      tx.objectStore(this.opts.store).clear();
      await transactionDone(tx);
    } catch {
      this.stats.failures++;
    }
  }

  /** Number of persisted records and their approximate total size. */
  async usage(): Promise<{ entries: number; bytes: number }> {
    try {
      const db = await this.opts.db();
      if (!db) return { entries: this.memory.size, bytes: 0 };
      const tx = db.transaction(this.opts.store, 'readonly');
      const store = tx.objectStore(this.opts.store);
      const entries = await requestToPromise(store.count());
      let bytes = 0;
      await new Promise<void>((resolve, reject) => {
        const cursorRequest = store.openCursor();
        cursorRequest.onerror = () => reject(cursorRequest.error);
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor) {
            resolve();
            return;
          }
          bytes += (cursor.value as CacheRecord).s ?? 0;
          cursor.continue();
        };
      });
      return { entries, bytes };
    } catch {
      this.stats.failures++;
      return { entries: this.memory.size, bytes: 0 };
    }
  }
}

function approximateSize(value: unknown): number {
  if (typeof value === 'string') return value.length * 2;
  try {
    return JSON.stringify(value).length * 2;
  } catch {
    return 0;
  }
}

// Persistent cache: IndexedDB behind a memory LRU, with validation, expiry and size limits.
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import { CacheStore, openCacheDb, resetCacheDbForTests } from '../../src/background/cache/store.ts';

const isString = (v: unknown): v is string => typeof v === 'string';
let factory: IDBFactory;
const db = (): Promise<IDBDatabase | null> => openCacheDb(factory as unknown as globalThis.IDBFactory);

function store(overrides: Partial<ConstructorParameters<typeof CacheStore<string>>[0]> = {}): CacheStore<string> {
  return new CacheStore<string>({ store: 'translations', validate: isString, maxEntries: 1000, ttlMs: 1e12, memoryEntries: 50, db, ...overrides });
}

beforeEach(() => {
  factory = new IDBFactory();
  resetCacheDbForTests();
});

describe('cache store', () => {
  it('persists values across instances (a restarted service worker)', async () => {
    const first = store();
    await first.set('k1', 'Привет');
    const second = store();
    expect(await second.get('k1')).toBe('Привет');
    expect(await second.get('missing')).toBeUndefined();
    expect(second.stats).toMatchObject({ hits: 1, misses: 1 });
    expect(await second.usage()).toMatchObject({ entries: 1 });
  });

  it('expires old records', async () => {
    let now = 1_000;
    const cache = store({ ttlMs: 500, now: () => now });
    await cache.set('k', 'старое');
    now += 400;
    expect(await store({ ttlMs: 500, now: () => now }).get('k')).toBe('старое');
    now += 200;
    const later = store({ ttlMs: 500, now: () => now });
    expect(await later.get('k')).toBeUndefined();
    expect((await later.usage()).entries).toBe(0);
  });

  it('drops records that fail validation instead of returning them', async () => {
    const loose = new CacheStore<unknown>({ store: 'translations', validate: (_v): _v is unknown => true, maxEntries: 10, ttlMs: 1e12, memoryEntries: 10, db });
    await loose.set('bad', { not: 'a string' });
    const strict = store();
    expect(await strict.get('bad')).toBeUndefined();
    expect((await strict.usage()).entries).toBe(0);
  });

  it('keeps the most recently used records when the limit is exceeded', async () => {
    let now = 0;
    const cache = store({ maxEntries: 3, now: () => now });
    for (const key of ['a', 'b', 'c', 'd', 'e']) {
      now += 10;
      await cache.set(key, key.toUpperCase());
    }
    expect(await cache.prune()).toBe(2);
    // Same clock as the writer: records written at "time 50" must not look expired.
    const fresh = store({ maxEntries: 3, now: () => now });
    expect(await fresh.get('a')).toBeUndefined();
    expect(await fresh.get('b')).toBeUndefined();
    expect(await fresh.get('e')).toBe('E');
    expect((await fresh.usage()).entries).toBe(3);
  });

  it('clears everything on request', async () => {
    const cache = store();
    await cache.set('k', 'v');
    await cache.clear();
    expect(await cache.get('k')).toBeUndefined();
    expect((await store().usage()).entries).toBe(0);
  });

  it('keeps working in memory when IndexedDB is unavailable', async () => {
    const cache = store({ db: () => Promise.resolve(null) });
    await cache.set('k', 'в памяти');
    expect(await cache.get('k')).toBe('в памяти');
    expect(await cache.prune()).toBe(0);
    await cache.clear();
    expect(await cache.get('k')).toBeUndefined();
  });

  it('never throws when the database fails', async () => {
    const cache = store({ db: () => Promise.reject(new Error('disk full')), memoryEntries: 1 });
    await expect(cache.set('a', '1')).resolves.toBeUndefined();
    await expect(cache.set('b', '2')).resolves.toBeUndefined();
    // "a" fell out of the one-entry memory cache and the database is broken: a clean miss.
    await expect(cache.get('a')).resolves.toBeUndefined();
    await expect(cache.get('b')).resolves.toBe('2');
    await expect(cache.usage()).resolves.toMatchObject({ bytes: 0 });
    expect(cache.stats.failures).toBeGreaterThan(0);
  });
});

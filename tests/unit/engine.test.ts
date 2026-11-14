// Translation engine: cache, de-duplication, priorities, cancellation, fallback, two-tier answers.
import { describe, expect, it } from 'vitest';
import { CacheStore } from '../../src/background/cache/store.ts';
import { TranslationEngine, cacheKey, plausibleTranslation } from '../../src/background/translation/engine.ts';
import { MetricsRegistry } from '../../src/background/translation/metrics.ts';
import type { TranslateRequest, TranslationProvider } from '../../src/background/translation/provider';
import type { ServerMessage } from '../../src/shared/messages';
import type { MitlesenError, Priority, ProviderId, ProviderStatus, TranslateItem } from '../../src/shared/types';

interface FakeOptions {
  speed?: 'fast' | 'slow';
  usesContext?: boolean;
  batchSize?: number;
  abortable?: boolean;
  delay?: number;
  fail?: MitlesenError;
  output?: (request: TranslateRequest) => string;
}

class FakeProvider implements TranslationProvider {
  readonly calls: string[][] = [];
  readonly aborted: string[][] = [];
  usableNow = true;
  readonly usesContext: boolean;
  readonly speed: 'fast' | 'slow';
  readonly batchSize: number;
  readonly abortable: boolean;
  readonly id: ProviderId;
  private readonly opts: FakeOptions;

  constructor(id: ProviderId, opts: FakeOptions = {}) {
    this.id = id;
    this.opts = opts;
    this.usesContext = opts.usesContext ?? false;
    this.speed = opts.speed ?? 'fast';
    this.batchSize = opts.batchSize ?? 1;
    this.abortable = opts.abortable ?? false;
  }
  cacheTag(): string {
    return 'test-model';
  }
  usable(): boolean {
    return this.usableNow;
  }
  status(): ProviderStatus {
    return { id: this.id, state: 'ready' };
  }
  check(): Promise<ProviderStatus> {
    return Promise.resolve(this.status());
  }
  async translate(batch: TranslateRequest[], signal: AbortSignal): Promise<string[]> {
    const texts = batch.map((r) => r.text);
    this.calls.push(texts);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, this.opts.delay ?? 1);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        this.aborted.push(texts);
        reject({ code: 'cancelled', message: 'aborted' } satisfies MitlesenError);
      });
    });
    if (this.opts.fail) throw this.opts.fail;
    return batch.map(this.opts.output ?? ((r) => `перевод ${'я'.repeat(r.text.length)}`));
  }
}

function setup(providers: FakeProvider[]) {
  const cache = new CacheStore<string>({ store: 'translations', validate: (v): v is string => typeof v === 'string', maxEntries: 100, ttlMs: 1e12, memoryEntries: 100, db: () => Promise.resolve(null) });
  const metrics = new MetricsRegistry();
  const engine = new TranslationEngine({ chain: () => providers, cache, metrics });
  const replies: ServerMessage[] = [];
  const reply = (message: ServerMessage): void => void replies.push(message);
  const item = (key: string, text: string, priority: Priority = 0, before: string[] = []): TranslateItem => ({ key, text, before, after: [], priority });
  const translated = (): { key: string; provider: ProviderId; cached: boolean; provisional: boolean }[] =>
    replies.flatMap((m) => (m.t === 'translated' ? [{ key: m.result.key, provider: m.result.provider, cached: m.result.cached, provisional: m.result.provisional === true }] : []));
  const errors = (): { key: string; code: string }[] => replies.flatMap((m) => (m.t === 'translate-error' ? [{ key: m.key, code: m.error.code }] : []));
  return { engine, cache, metrics, replies, reply, item, translated, errors };
}

async function until(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 3));
  }
}

describe('translation engine', () => {
  it('translates, then answers the same request from the cache', async () => {
    const provider = new FakeProvider('opus-browser');
    const t = setup([provider]);
    t.engine.submit('tab1', [t.item('a', 'Guten Morgen')], t.reply);
    await until(() => t.translated().length === 1);
    expect(t.translated()[0]).toMatchObject({ key: 'a', provider: 'opus-browser', cached: false });
    t.engine.submit('tab1', [t.item('b', 'Guten Morgen')], t.reply);
    await until(() => t.translated().length === 2);
    expect(t.translated()[1]).toMatchObject({ key: 'b', cached: true });
    expect(provider.calls).toHaveLength(1);
    expect(t.metrics.snapshot()[0]).toMatchObject({ id: 'opus-browser', requests: 1, errors: 0 });
  });

  it('runs identical requests of two tabs only once', async () => {
    const provider = new FakeProvider('opus-browser', { delay: 20 });
    const t = setup([provider]);
    t.engine.submit('tab1', [t.item('a', 'Wie geht es dir?')], t.reply);
    t.engine.submit('tab2', [t.item('x', 'Wie geht es dir?')], t.reply);
    await until(() => t.translated().length === 2);
    expect(provider.calls).toEqual([['Wie geht es dir?']]);
    expect(t.translated().map((r) => r.key).sort()).toEqual(['a', 'x']);
  });

  it('context matters only for providers that use it', () => {
    const plain = new FakeProvider('opus-browser');
    const contextual = new FakeProvider('ollama', { usesContext: true });
    const a = { text: 'Sie ist umgezogen.', before: ['Wohnt Anna noch hier?'], after: [] };
    const b = { text: 'Sie ist umgezogen.', before: ['Warum trägt sie ein Kleid?'], after: [] };
    expect(cacheKey(plain, a)).toBe(cacheKey(plain, b));
    expect(cacheKey(contextual, a)).not.toBe(cacheKey(contextual, b));
    expect(cacheKey(plain, a)).not.toBe(cacheKey(contextual, a));
  });

  it('serves the line on screen before background work', async () => {
    const provider = new FakeProvider('opus-browser', { delay: 15 });
    const t = setup([provider]);
    t.engine.submit('tab', [t.item('bg1', 'eins', 2), t.item('bg2', 'zwei', 2), t.item('bg3', 'drei', 2)], t.reply);
    await until(() => provider.calls.length === 1);
    t.engine.submit('tab', [t.item('now', 'jetzt', 0)], t.reply);
    await until(() => t.translated().length === 4);
    // "eins" was already running; the urgent line goes next, ahead of "zwei" and "drei".
    expect(provider.calls.map((c) => c[0])).toEqual(['eins', 'jetzt', 'zwei', 'drei']);
  });

  it('batches background work up to the provider limit, never the urgent line', async () => {
    const provider = new FakeProvider('local-service', { batchSize: 3, delay: 5 });
    const t = setup([provider]);
    t.engine.submit('tab', [t.item('1', 'eins', 2), t.item('2', 'zwei', 2), t.item('3', 'drei', 2), t.item('4', 'vier', 2)], t.reply);
    await until(() => t.translated().length === 4);
    expect(provider.calls.map((c) => c.length)).toEqual([3, 1]);
    t.engine.submit('tab', [t.item('5', 'fünf', 0), t.item('6', 'sechs', 1)], t.reply);
    await until(() => t.translated().length === 6);
    expect(provider.calls.slice(2).map((c) => c.length)).toEqual([1, 1]);
  });

  it('drops cancelled requests and keeps the listed ones', async () => {
    const provider = new FakeProvider('opus-browser', { delay: 15 });
    const t = setup([provider]);
    t.engine.submit('tab', [t.item('a', 'eins', 2), t.item('b', 'zwei', 2), t.item('c', 'drei', 2)], t.reply);
    await until(() => provider.calls.length === 1);
    t.engine.cancel('tab', new Set(['c']));
    await until(() => t.translated().some((r) => r.key === 'c'));
    await new Promise((r) => setTimeout(r, 40));
    expect(provider.calls.flat()).toEqual(['eins', 'drei']);
    expect(t.translated().map((r) => r.key)).toEqual(['c']);
    expect(t.engine.stats()).toEqual({ waiting: 0, inFlight: 0 });
  });

  it('aborts background work on an abortable provider when an urgent line arrives', async () => {
    const provider = new FakeProvider('ollama', { delay: 150, abortable: true, speed: 'slow', usesContext: true });
    const t = setup([provider]);
    t.engine.submit('tab', [t.item('bg', 'Hintergrund', 2)], t.reply);
    await until(() => provider.calls.length === 1);
    t.engine.submit('tab', [t.item('now', 'jetzt', 0)], t.reply);
    await until(() => t.translated().length === 2, 3000);
    expect(provider.aborted).toEqual([['Hintergrund']]);
    expect(provider.calls.map((c) => c[0])).toEqual(['Hintergrund', 'jetzt', 'Hintergrund']);
    expect(t.errors()).toEqual([]);
  });

  it('falls back to the next provider when the preferred one fails', async () => {
    const broken = new FakeProvider('ollama', { fail: { code: 'unreachable', message: 'down' }, speed: 'slow' });
    const backup = new FakeProvider('opus-browser');
    const t = setup([broken, backup]);
    t.engine.submit('tab', [t.item('a', 'Hallo', 1)], t.reply);
    await until(() => t.translated().length === 1);
    expect(t.translated()[0]).toMatchObject({ provider: 'opus-browser', provisional: false });
    expect(t.metrics.snapshot().find((m) => m.id === 'ollama')).toMatchObject({ requests: 1, errors: 1 });
  });

  it('reports the last error when every provider fails, and when none is usable', async () => {
    const a = new FakeProvider('local-service', { fail: { code: 'unreachable', message: 'service down' } });
    const b = new FakeProvider('opus-browser', { fail: { code: 'model-load', message: 'no model' } });
    const t = setup([a, b]);
    t.engine.submit('tab', [t.item('x', 'Hallo')], t.reply);
    await until(() => t.errors().length === 1);
    expect(t.errors()[0]).toEqual({ key: 'x', code: 'model-load' });
    a.usableNow = false;
    b.usableNow = false;
    t.engine.submit('tab', [t.item('y', 'Tschüss')], t.reply);
    await until(() => t.errors().length === 2);
    expect(t.errors()[1]).toEqual({ key: 'y', code: 'no-provider' });
  });

  it('answers an on-screen line with a fast draft first, then with the preferred provider', async () => {
    const llm = new FakeProvider('ollama', { delay: 60, speed: 'slow', usesContext: true });
    const nmt = new FakeProvider('local-service', { delay: 3 });
    const t = setup([llm, nmt]);
    t.engine.submit('tab', [t.item('now', 'Ich verstehe nur Bahnhof.', 0)], t.reply);
    await until(() => t.translated().length === 2);
    expect(t.translated()).toEqual([
      { key: 'now', provider: 'local-service', cached: false, provisional: true },
      { key: 'now', provider: 'ollama', cached: false, provisional: false },
    ]);
    // Background lines go to the preferred provider only.
    t.engine.submit('tab', [t.item('later', 'Bis morgen.', 2)], t.reply);
    await until(() => t.translated().length === 3);
    expect(nmt.calls).toHaveLength(1);
  });

  it('rejects output that is not a plausible Russian translation', async () => {
    const echo = new FakeProvider('ollama', { speed: 'slow', output: (r) => r.text });
    const backup = new FakeProvider('opus-browser');
    const t = setup([echo, backup]);
    t.engine.submit('tab', [t.item('a', 'Das ist ein Test.', 1)], t.reply);
    await until(() => t.translated().length === 1);
    expect(t.translated()[0]!.provider).toBe('opus-browser');
    expect(plausibleTranslation('Hallo', '')).toBe(false);
    expect(plausibleTranslation('Hallo', 'Привет')).toBe(true);
    expect(plausibleTranslation('Hallo', 'привет '.repeat(60))).toBe(false);
  });
});

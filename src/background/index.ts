// Background service worker: owns settings, providers, the translation engine, caches and the
// grammar service, and routes messages between content scripts, the popup and the offscreen page.
import {
  PORT_NAME,
  isClientMessage,
  isOffscreenEvent,
  isRuntimeRequest,
  makeError,
  toError,
  type RuntimeResponse,
  type ServerMessage,
} from '../shared/messages.ts';
import { DEFAULT_SETTINGS, isLoopback, loadSettings, onSettingsChanged, type Settings } from '../shared/settings.ts';
import { hashString, tokenize } from '../shared/text.ts';
import type { Diagnostics, MitlesenError, ProviderId, ProviderStatus, SentenceAnalysis } from '../shared/types';
import { AnalysisService, isSentenceAnalysis } from './analysis/service.ts';
import { CacheStore } from './cache/store.ts';
import { TranslationEngine } from './translation/engine.ts';
import { LatencyWindow, MetricsRegistry } from './translation/metrics.ts';
import type { TranslationProvider } from './translation/provider';
import { LocalServiceProvider } from './translation/providers/local-service.ts';
import { OllamaProvider } from './translation/providers/ollama.ts';
import { OpusBrowserProvider } from './translation/providers/opus-browser.ts';

declare const __VERSION__: string;

const DAY = 86_400_000;
let settings: Settings = DEFAULT_SETTINGS;
const ports = new Map<string, chrome.runtime.Port>();
let lastError: (MitlesenError & { at: number }) | undefined;

const translationCache = new CacheStore<string>({
  store: 'translations',
  validate: (v): v is string => typeof v === 'string' && v.length > 0 && v.length < 4000,
  maxEntries: 30_000,
  ttlMs: 180 * DAY,
  memoryEntries: 600,
});
const analysisCache = new CacheStore<SentenceAnalysis>({
  store: 'analyses',
  validate: isSentenceAnalysis,
  maxEntries: 1_500,
  ttlMs: 30 * DAY,
  memoryEntries: 120,
});

const metrics = new MetricsRegistry();
const analysisLatency = new LatencyWindow();

function broadcast(message: ServerMessage): void {
  for (const port of ports.values()) {
    try {
      port.postMessage(message);
    } catch {
      /* the port is closing */
    }
  }
}

function providerChanged(provider: TranslationProvider): void {
  broadcast({ t: 'provider-status', status: provider.status() });
  engine.kick();
}

const opusBrowser = new OpusBrowserProvider(() => providerChanged(opusBrowser));
const localService = new LocalServiceProvider(
  () => settings.serviceEndpoint,
  () => providerChanged(localService),
);
const ollama = new OllamaProvider(
  () => ({ endpoint: settings.ollamaEndpoint, model: settings.ollamaModel, fullGpu: settings.ollamaFullGpu }),
  () => providerChanged(ollama),
);

/** Providers in order of preference for the current settings. The browser model is always the last resort. */
function chain(): TranslationProvider[] {
  if (settings.mode === 'browser') return [opusBrowser];
  // With Ollama chosen, the OPUS-MT providers still supply the fast first draft and the fallback.
  if (settings.localProvider === 'ollama') return [ollama, localService, opusBrowser];
  return [localService, opusBrowser];
}

const engine = new TranslationEngine({ chain, cache: translationCache, metrics });
const analysis = new AnalysisService({
  cache: analysisCache,
  latency: analysisLatency,
  // The grammar part of the local service is used whenever the service is reachable in local mode.
  parserEndpoint: () => (settings.mode === 'local' && localService.health?.analyze.ready ? settings.serviceEndpoint : null),
});

// ── provider health ──

let lastCheck = 0;
let checking: Promise<void> | null = null;

function checkProviders(force = false): Promise<void> {
  if (checking) return checking;
  if (!force && Date.now() - lastCheck < 20_000) return Promise.resolve();
  lastCheck = Date.now();
  const active = chain();
  checking = Promise.all([
    ...active.map((p) => p.check()),
    // The grammar service is probed in local mode even when translation uses another provider.
    settings.mode === 'local' && !active.includes(localService) ? localService.check() : Promise.resolve(),
  ])
    .then(() => engine.kick())
    .finally(() => {
      checking = null;
    });
  return checking;
}

/**
 * Ollama rejects requests whose Origin header is not on its allow-list, and an extension's
 * origin is not on it by default. For requests that this extension itself sends to the
 * endpoint the user configured, the header is dropped. Pages on the web are not affected:
 * the rule only matches requests initiated by this extension.
 */
async function syncOriginRule(): Promise<void> {
  const RULE_ID = 1;
  try {
    const wanted = settings.mode === 'local' && settings.localProvider === 'ollama' && isLoopback(settings.ollamaEndpoint);
    const addRules: chrome.declarativeNetRequest.Rule[] = wanted
      ? [
          {
            id: RULE_ID,
            priority: 1,
            action: { type: 'modifyHeaders', requestHeaders: [{ header: 'origin', operation: 'remove' }] },
            condition: { urlFilter: `|${settings.ollamaEndpoint}/`, initiatorDomains: [chrome.runtime.id], resourceTypes: ['xmlhttprequest'] },
          } as chrome.declarativeNetRequest.Rule,
        ]
      : [];
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [RULE_ID], addRules });
  } catch (e) {
    lastError = { ...toError(e), at: Date.now() };
  }
}

const ready: Promise<void> = loadSettings().then(async (loaded) => {
  settings = loaded;
  await syncOriginRule();
  void checkProviders(true);
});

onSettingsChanged((next) => {
  settings = next;
  void syncOriginRule().then(() => checkProviders(true));
});

// ── content scripts ──

let portSeq = 0;

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PORT_NAME || port.sender?.id !== chrome.runtime.id) {
    port.disconnect();
    return;
  }
  const clientId = `c${++portSeq}-${port.sender.tab?.id ?? 'x'}-${port.sender.frameId ?? 0}`;
  ports.set(clientId, port);
  const reply = (message: ServerMessage): void => {
    try {
      port.postMessage(message);
    } catch {
      /* the tab went away */
    }
  };

  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    ports.delete(clientId);
    engine.cancel(clientId);
  });

  port.onMessage.addListener((message: unknown) => {
    if (!isClientMessage(message)) return;
    void ready.then(async () => {
      switch (message.t) {
        case 'translate': {
          const now = Date.now();
          // Nothing usable yet (first run, or everything failed): look again before answering.
          if (!chain().some((p) => p.usable(now))) await checkProviders(now - lastCheck > 3_000);
          else void checkProviders();
          engine.submit(clientId, message.items, (m) => {
            if (m.t === 'translate-error') lastError = { ...m.error, at: Date.now() };
            reply(m);
          });
          return;
        }
        case 'cancel':
          engine.cancel(clientId, new Set(message.keep));
          return;
        case 'analyze':
          try {
            reply({ t: 'analysis', id: message.id, analysis: await analysis.analyze(message.sentence, message.translation) });
          } catch (e) {
            reply({ t: 'analysis', id: message.id, error: toError(e) });
          }
          return;
        case 'word-context':
          reply({ t: 'word-context', id: message.id, ...(await wordInContext(message.sentence, message.tokenIndex)) });
          return;
        case 'ping':
          reply({ t: 'pong' });
          return;
      }
    });
  });
});

/** Meaning of one word in its sentence, from the first usable context-aware provider. */
async function wordInContext(sentence: string, tokenIndex: number): Promise<{ text?: string; error?: MitlesenError }> {
  const token = tokenize(sentence)[tokenIndex];
  const provider = chain().find((p) => p.wordInContext && p.usable(Date.now()));
  if (!token || token.kind !== 'word' || !provider?.wordInContext) return { error: makeError('no-provider', 'no context-aware provider') };
  const key = `w1|${provider.id}|${provider.cacheTag()}|${hashString(sentence)}|${tokenIndex}`;
  const cached = await translationCache.get(key);
  if (cached !== undefined) return { text: cached };
  try {
    const text = (await provider.wordInContext(sentence, token.text, AbortSignal.timeout(20_000))).trim();
    if (text.length === 0 || text.length > 80 || !/\p{Script=Cyrillic}/u.test(text)) return { error: makeError('bad-response', 'unusable answer') };
    void translationCache.set(key, text);
    return { text };
  } catch (e) {
    return { error: toError(e) };
  }
}

// ── popup and offscreen document ──

async function diagnostics(): Promise<Diagnostics> {
  const [translations, analyses] = await Promise.all([translationCache.usage(), analysisCache.usage()]);
  const now = Date.now();
  const active = chain().find((p) => p.usable(now));
  const providers: ProviderStatus[] = [opusBrowser, localService, ollama].map((p) => p.status());
  if (opusBrowser.initMs !== undefined) metrics.init('opus-browser', opusBrowser.initMs);
  return {
    version: __VERSION__,
    browser: navigator.userAgent,
    offscreenApi: typeof chrome.offscreen?.createDocument === 'function',
    activeProvider: active?.id ?? null,
    providers,
    metrics: metrics.snapshot(),
    cache: {
      translations: translations.entries,
      analyses: analyses.entries,
      hits: translationCache.stats.hits + analysisCache.stats.hits,
      misses: translationCache.stats.misses + analysisCache.stats.misses,
      approxBytes: translations.bytes + analyses.bytes,
    },
    queue: engine.stats(),
    dictionary: await analysis.dictionaryInfo(),
    analysisEngine: analysis.engine(),
    analysisLatency: analysisLatency.stats(),
    lastError,
  };
}

const SITE_SCRIPT_PREFIX = 'site-';

async function registeredSites(): Promise<string[]> {
  const scripts = await chrome.scripting.getRegisteredContentScripts();
  return scripts.filter((s) => s.id.startsWith(SITE_SCRIPT_PREFIX)).flatMap((s) => (s.matches ?? []).map((m) => m.replace(/\/\*$/, '')));
}

async function handleRuntime(message: unknown): Promise<RuntimeResponse> {
  if (!isRuntimeRequest(message)) return { ok: false, error: makeError('internal', 'unknown request') };
  await ready;
  switch (message.t) {
    case 'diagnostics':
      await checkProviders();
      return { ok: true, diagnostics: await diagnostics(), sites: await registeredSites() };
    case 'check-provider': {
      const provider = ({ 'opus-browser': opusBrowser, 'local-service': localService, ollama } as Record<ProviderId, TranslationProvider>)[message.provider];
      await syncOriginRule();
      const status = await provider.check();
      engine.kick();
      return { ok: true, status };
    }
    case 'clear-cache':
      await Promise.all([translationCache.clear(), analysisCache.clear()]);
      return { ok: true };
    case 'warmup':
      void opusBrowser.warmUp();
      return { ok: true };
    case 'register-site': {
      const id = SITE_SCRIPT_PREFIX + hashString(message.origin);
      const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [id] });
      if (existing.length === 0) {
        await chrome.scripting.registerContentScripts([
          { id, matches: [`${message.origin}/*`], js: ['content.js'], allFrames: true, runAt: 'document_idle', persistAcrossSessions: true },
        ]);
      }
      return { ok: true, sites: await registeredSites() };
    }
    case 'unregister-site':
      await chrome.scripting.unregisterContentScripts({ ids: [SITE_SCRIPT_PREFIX + hashString(message.origin)] }).catch(() => undefined);
      return { ok: true, sites: await registeredSites() };
  }
}

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return undefined;
  if (isOffscreenEvent(message)) {
    if (message.t === 'mt-progress') opusBrowser.handleProgress(message.progress);
    return undefined;
  }
  // Content scripts talk through ports; one-shot requests are accepted from extension pages only
  // (the popup, or the same page opened in a tab), never from a web page's content script.
  const fromExtensionPage = sender.url?.startsWith(`chrome-extension://${chrome.runtime.id}/`) ?? false;
  if (!fromExtensionPage || !isRuntimeRequest(message)) return undefined;
  handleRuntime(message)
    .then(sendResponse)
    .catch((e: unknown) => sendResponse({ ok: false, error: toError(e) } satisfies RuntimeResponse));
  return true;
});

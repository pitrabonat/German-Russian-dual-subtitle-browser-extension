// Message protocol between the content script, the background worker, the popup and the
// offscreen document. Every incoming message is checked with a type guard before use.
import type {
  AdapterStatus,
  Diagnostics,
  MitlesenError,
  ProviderId,
  ProviderStatus,
  SentenceAnalysis,
  TrackInfo,
  TranslateItem,
  TranslationResult,
} from './types';

export const PORT_NAME = 'mitlesen';

export const LIMITS = {
  textLength: 1200,
  contextLines: 8,
  itemsPerMessage: 64,
  keysPerCancel: 256,
} as const;

// ── content script → background (over a Port) ──

export type ClientMessage =
  | { t: 'translate'; items: TranslateItem[] }
  | { t: 'cancel'; keep: string[] }
  | { t: 'analyze'; id: number; sentence: string; translation?: string }
  | { t: 'word-context'; id: number; sentence: string; tokenIndex: number }
  | { t: 'ping' };

// ── background → content script (over a Port) ──

export type ServerMessage =
  | { t: 'translated'; result: TranslationResult }
  | { t: 'translate-error'; key: string; error: MitlesenError }
  | { t: 'analysis'; id: number; analysis?: SentenceAnalysis; error?: MitlesenError }
  | { t: 'word-context'; id: number; text?: string; error?: MitlesenError }
  | { t: 'provider-status'; status: ProviderStatus }
  | { t: 'pong' };

// ── popup → background (one-shot) ──

export type RuntimeRequest =
  | { t: 'diagnostics' }
  | { t: 'check-provider'; provider: ProviderId }
  | { t: 'clear-cache' }
  | { t: 'warmup' }
  | { t: 'register-site'; origin: string }
  | { t: 'unregister-site'; origin: string };

export type RuntimeResponse =
  | { ok: true; diagnostics?: Diagnostics; status?: ProviderStatus; sites?: string[] }
  | { ok: false; error: MitlesenError };

// ── popup → content script (one-shot, via tabs.sendMessage) ──

export type PageRequest = { t: 'page-state' } | { t: 'select-track'; id: string };

export interface PageState {
  adapter: string | null;
  status: AdapterStatus;
  tracks: TrackInfo[];
  activeTrackId: string | null;
  cueCount: number;
}

// ── background ↔ offscreen document ──

export type OffscreenRequest =
  | { target: 'offscreen'; t: 'mt-translate'; id: number; texts: string[] }
  | { target: 'offscreen'; t: 'mt-status' }
  | { target: 'offscreen'; t: 'mt-dispose' };

export type OffscreenEvent =
  | { target: 'background'; t: 'mt-progress'; progress: number; file?: string }
  | { target: 'background'; t: 'mt-keepalive' };

export interface OffscreenTranslateResponse {
  ok: boolean;
  translations?: string[];
  ms?: number;
  device?: string;
  initMs?: number;
  error?: MitlesenError;
}

// ── validation ──

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isShortString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max;
}

function isStringArray(value: unknown, maxItems: number, maxLength: number): value is string[] {
  return Array.isArray(value) && value.length <= maxItems && value.every((v) => isShortString(v, maxLength));
}

function isTranslateItem(value: unknown): value is TranslateItem {
  return (
    isObject(value) &&
    isShortString(value.key, 64) &&
    isShortString(value.text, LIMITS.textLength) &&
    value.text.length > 0 &&
    isStringArray(value.before, LIMITS.contextLines, LIMITS.textLength) &&
    isStringArray(value.after, LIMITS.contextLines, LIMITS.textLength) &&
    (value.priority === 0 || value.priority === 1 || value.priority === 2)
  );
}

/** Type guard for messages arriving from a content script. */
export function isClientMessage(value: unknown): value is ClientMessage {
  if (!isObject(value)) return false;
  switch (value.t) {
    case 'translate':
      return Array.isArray(value.items) && value.items.length <= LIMITS.itemsPerMessage && value.items.every(isTranslateItem);
    case 'cancel':
      return isStringArray(value.keep, LIMITS.keysPerCancel, 64);
    case 'analyze':
      return (
        Number.isSafeInteger(value.id) &&
        isShortString(value.sentence, LIMITS.textLength) &&
        (value.translation === undefined || isShortString(value.translation, LIMITS.textLength * 2))
      );
    case 'word-context':
      return (
        Number.isSafeInteger(value.id) &&
        isShortString(value.sentence, LIMITS.textLength) &&
        Number.isSafeInteger(value.tokenIndex) &&
        (value.tokenIndex as number) >= 0
      );
    case 'ping':
      return true;
    default:
      return false;
  }
}

const PROVIDERS: readonly ProviderId[] = ['opus-browser', 'local-service', 'ollama'];

/** Type guard for one-shot requests from the popup. */
export function isRuntimeRequest(value: unknown): value is RuntimeRequest {
  if (!isObject(value)) return false;
  switch (value.t) {
    case 'diagnostics':
    case 'clear-cache':
    case 'warmup':
      return true;
    case 'check-provider':
      return typeof value.provider === 'string' && (PROVIDERS as readonly string[]).includes(value.provider);
    case 'register-site':
    case 'unregister-site':
      // Either one origin, or the wildcard that stands for every site.
      return isShortString(value.origin, 300) && /^(https?:\/\/[^/*]+|\*:\/\/\*)$/.test(value.origin);
    default:
      return false;
  }
}

export function isPageRequest(value: unknown): value is PageRequest {
  if (!isObject(value)) return false;
  if (value.t === 'page-state') return true;
  return value.t === 'select-track' && isShortString(value.id, 200);
}

export function isOffscreenEvent(value: unknown): value is OffscreenEvent {
  if (!isObject(value) || value.target !== 'background') return false;
  if (value.t === 'mt-keepalive') return true;
  return value.t === 'mt-progress' && typeof value.progress === 'number';
}

export function isOffscreenRequest(value: unknown): value is OffscreenRequest {
  if (!isObject(value) || value.target !== 'offscreen') return false;
  if (value.t === 'mt-status' || value.t === 'mt-dispose') return true;
  return value.t === 'mt-translate' && Number.isSafeInteger(value.id) && isStringArray(value.texts, 32, LIMITS.textLength * 4);
}

export function makeError(code: MitlesenError['code'], message: string): MitlesenError {
  return { code, message };
}

/** Converts anything thrown into a MitlesenError. */
export function toError(e: unknown, fallback: MitlesenError['code'] = 'internal'): MitlesenError {
  if (isObject(e) && typeof e.code === 'string' && typeof e.message === 'string') return e as unknown as MitlesenError;
  if (e instanceof DOMException && e.name === 'AbortError') return { code: 'cancelled', message: 'cancelled' };
  if (e instanceof DOMException && e.name === 'TimeoutError') return { code: 'timeout', message: 'timed out' };
  return { code: fallback, message: e instanceof Error ? e.message : String(e) };
}

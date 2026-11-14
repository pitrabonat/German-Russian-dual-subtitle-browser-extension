// User preferences: schema, defaults, validation and storage access.
//
// Preferences live in chrome.storage.local under one key. They are small and human-editable;
// bulky derived data (translation cache, word analyses) lives in IndexedDB instead.

export type TranslationMode = 'browser' | 'local';
/**
 * Translator of the local mode. The Mitlesen service (OPUS-MT) is the default because it scored
 * higher and answered faster than a 4B language model in our measurements (MODEL_COMPARISON.md).
 */
export type LocalProviderChoice = 'local-service' | 'ollama';

export interface Appearance {
  /** German line height as a percentage of the video height. */
  fontScale: number;
  /** Russian line size relative to the German line. */
  ruScale: number;
  deColor: string;
  ruColor: string;
  /** 0 = transparent, 1 = solid black behind the text. */
  bgOpacity: number;
  /** Distance of the subtitle block from the bottom edge, percent of the video height. */
  position: number;
  /** Gap between the German and the Russian line, percent of the German font size. */
  lineGap: number;
}

export interface Settings {
  schema: 1;
  enabled: boolean;
  showGerman: boolean;
  showRussian: boolean;
  /** Word explanations on hover or tap. */
  wordPopup: boolean;
  /** Pause the video while a word explanation is open. */
  pauseOnHover: boolean;
  /** `browser`: model runs inside the extension. `local`: use a service on this computer first. */
  mode: TranslationMode;
  localProvider: LocalProviderChoice;
  ollamaEndpoint: string;
  ollamaModel: string;
  /** Ask Ollama to put every model layer on the GPU (its automatic split is very conservative on 4 GB cards). */
  ollamaFullGpu: boolean;
  serviceEndpoint: string;
  /** Number of preceding subtitle lines sent as context (0 to 6). */
  contextSize: number;
  /** How many upcoming subtitle groups are translated ahead of playback. */
  preloadAhead: number;
  /** Join subtitle lines that belong to one sentence before translating. */
  mergeFragments: boolean;
  appearance: Appearance;
}

export const SETTINGS_KEY = 'settings';

export const DEFAULT_SETTINGS: Settings = {
  schema: 1,
  enabled: true,
  showGerman: true,
  showRussian: true,
  wordPopup: true,
  pauseOnHover: true,
  mode: 'browser',
  localProvider: 'local-service',
  ollamaEndpoint: 'http://127.0.0.1:11434',
  ollamaModel: 'qwen3:4b-instruct',
  ollamaFullGpu: false,
  serviceEndpoint: 'http://127.0.0.1:8765',
  contextSize: 2,
  preloadAhead: 12,
  mergeFragments: true,
  appearance: {
    fontScale: 3.6,
    ruScale: 0.82,
    deColor: '#ffffff',
    ruColor: '#ffd98a',
    bgOpacity: 0.62,
    position: 9,
    lineGap: 18,
  },
};

export const LIMITS = {
  fontScale: [1.8, 8],
  ruScale: [0.5, 1.2],
  bgOpacity: [0, 1],
  position: [1, 85],
  lineGap: [0, 80],
  contextSize: [0, 6],
  preloadAhead: [0, 60],
} as const;

function num(value: unknown, fallback: number, [min, max]: readonly [number, number]): number {
  const n = typeof value === 'number' ? value : Number.NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

function color(value: unknown, fallback: string): string {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value) ? value.toLowerCase() : fallback;
}

/** Normalises an endpoint to `scheme://host[:port]`; returns the fallback for anything else. */
export function normalizeEndpoint(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return fallback;
    if (url.username || url.password) return fallback;
    return url.origin;
  } catch {
    return fallback;
  }
}

/** True for addresses that never leave this computer. */
export function isLoopback(endpoint: string): boolean {
  try {
    const host = new URL(endpoint).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
  } catch {
    return false;
  }
}

function modelName(value: unknown, fallback: string): string {
  return typeof value === 'string' && /^[\w.\-:/]{1,120}$/.test(value.trim()) ? value.trim() : fallback;
}

/** Turns arbitrary stored data into a valid Settings object. Unknown or broken fields fall back to defaults. */
export function sanitizeSettings(raw: unknown): Settings {
  const d = DEFAULT_SETTINGS;
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const a = (r.appearance && typeof r.appearance === 'object' ? r.appearance : {}) as Record<string, unknown>;
  return {
    schema: 1,
    enabled: bool(r.enabled, d.enabled),
    showGerman: bool(r.showGerman, d.showGerman),
    showRussian: bool(r.showRussian, d.showRussian),
    wordPopup: bool(r.wordPopup, d.wordPopup),
    pauseOnHover: bool(r.pauseOnHover, d.pauseOnHover),
    mode: oneOf(r.mode, ['browser', 'local'] as const, d.mode),
    localProvider: oneOf(r.localProvider, ['local-service', 'ollama'] as const, d.localProvider),
    ollamaEndpoint: normalizeEndpoint(r.ollamaEndpoint, d.ollamaEndpoint),
    ollamaModel: modelName(r.ollamaModel, d.ollamaModel),
    ollamaFullGpu: bool(r.ollamaFullGpu, d.ollamaFullGpu),
    serviceEndpoint: normalizeEndpoint(r.serviceEndpoint, d.serviceEndpoint),
    contextSize: Math.round(num(r.contextSize, d.contextSize, LIMITS.contextSize)),
    preloadAhead: Math.round(num(r.preloadAhead, d.preloadAhead, LIMITS.preloadAhead)),
    mergeFragments: bool(r.mergeFragments, d.mergeFragments),
    appearance: {
      fontScale: num(a.fontScale, d.appearance.fontScale, LIMITS.fontScale),
      ruScale: num(a.ruScale, d.appearance.ruScale, LIMITS.ruScale),
      deColor: color(a.deColor, d.appearance.deColor),
      ruColor: color(a.ruColor, d.appearance.ruColor),
      bgOpacity: num(a.bgOpacity, d.appearance.bgOpacity, LIMITS.bgOpacity),
      position: num(a.position, d.appearance.position, LIMITS.position),
      lineGap: num(a.lineGap, d.appearance.lineGap, LIMITS.lineGap),
    },
  };
}

export async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  return sanitizeSettings(stored[SETTINGS_KEY]);
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({ [SETTINGS_KEY]: sanitizeSettings(settings) });
}

/** Applies a partial change and stores the result. Returns the new settings. */
export async function updateSettings(patch: Partial<Omit<Settings, 'appearance'>> & { appearance?: Partial<Appearance> }): Promise<Settings> {
  const current = await loadSettings();
  const next = sanitizeSettings({ ...current, ...patch, appearance: { ...current.appearance, ...(patch.appearance ?? {}) } });
  await saveSettings(next);
  return next;
}

/** Calls `listener` whenever the stored settings change. Returns an unsubscribe function. */
export function onSettingsChanged(listener: (settings: Settings) => void): () => void {
  const handler = (changes: Record<string, chrome.storage.StorageChange>, area: string): void => {
    if (area === 'local' && changes[SETTINGS_KEY]) listener(sanitizeSettings(changes[SETTINGS_KEY].newValue));
  };
  chrome.storage.onChanged.addListener(handler);
  return () => chrome.storage.onChanged.removeListener(handler);
}

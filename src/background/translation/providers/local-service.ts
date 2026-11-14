// Provider for the optional Mitlesen local service (Python): OPUS-MT through CTranslate2.
import type { MitlesenError, ProviderStatus } from '../../../shared/types';
import { makeError, toError } from '../../../shared/messages.ts';
import { ProviderHealth, withTimeout, type TranslateRequest, type TranslationProvider } from '../provider.ts';

export interface ServiceHealth {
  service: 'mitlesen';
  version: string;
  translate: { ready: boolean; model?: string; device?: string; error?: string };
  analyze: { ready: boolean; model?: string; error?: string };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Validates the /health payload; anything else on that port is not our service. */
export function parseHealth(value: unknown): ServiceHealth | null {
  if (!isObject(value) || value.service !== 'mitlesen' || typeof value.version !== 'string') return null;
  const part = (v: unknown): { ready: boolean; model?: string; device?: string; error?: string } | null => {
    if (!isObject(v) || typeof v.ready !== 'boolean') return null;
    return {
      ready: v.ready,
      model: typeof v.model === 'string' ? v.model : undefined,
      device: typeof v.device === 'string' ? v.device : undefined,
      error: typeof v.error === 'string' ? v.error : undefined,
    };
  };
  const translate = part(value.translate);
  const analyze = part(value.analyze);
  if (!translate || !analyze) return null;
  return { service: 'mitlesen', version: value.version, translate, analyze };
}

const REQUEST_TIMEOUT_MS = 20_000;
const CHECK_TIMEOUT_MS = 3_000;

export class LocalServiceProvider extends ProviderHealth implements TranslationProvider {
  readonly id = 'local-service' as const;
  readonly usesContext = false;
  readonly speed = 'fast' as const;
  readonly batchSize = 4;
  readonly abortable = true;

  private state: ProviderStatus['state'] = 'unknown';
  private detail: string | undefined;
  private error: MitlesenError | undefined;
  private checkedAt = 0;
  private model = 'opus-mt-tc-big-de-zle';
  private endpointSeen = '';
  health: ServiceHealth | null = null;

  constructor(
    private readonly endpoint: () => string,
    private readonly onChange: () => void = () => {},
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
    private readonly now: () => number = () => Date.now(),
  ) {
    super();
  }

  cacheTag(): string {
    return this.model;
  }

  private resetIfReconfigured(): void {
    const endpoint = this.endpoint();
    if (endpoint === this.endpointSeen) return;
    this.endpointSeen = endpoint;
    this.state = 'unknown';
    this.health = null;
    this.detail = undefined;
    this.error = undefined;
    this.noteSuccess();
  }

  usable(now: number): boolean {
    this.resetIfReconfigured();
    return this.state === 'ready' && !this.coolingDown(now);
  }

  status(): ProviderStatus {
    this.resetIfReconfigured();
    return { id: this.id, state: this.state, detail: this.detail, error: this.error, checkedAt: this.checkedAt || undefined };
  }

  private set(state: ProviderStatus['state'], detail?: string, error?: MitlesenError): ProviderStatus {
    const changed = state !== this.state || detail !== this.detail;
    this.state = state;
    this.detail = detail;
    this.error = error;
    this.checkedAt = this.now();
    if (changed) this.onChange();
    return this.status();
  }

  async check(): Promise<ProviderStatus> {
    this.resetIfReconfigured();
    try {
      const res = await this.fetchImpl(`${this.endpoint()}/health`, { signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
      if (!res.ok) return this.set('error', undefined, makeError('bad-response', `Локальный сервис ответил кодом ${res.status}.`));
      const health = parseHealth(await res.json());
      if (!health) return this.set('error', undefined, makeError('bad-response', 'По этому адресу отвечает не сервис Mitlesen.'));
      this.health = health;
      if (!health.translate.ready) {
        return this.set('error', undefined, makeError('model-load', health.translate.error ?? 'Модель перевода в сервисе не загружена.'));
      }
      if (health.translate.model) this.model = health.translate.model;
      this.noteSuccess();
      return this.set('ready', [health.translate.model, health.translate.device].filter(Boolean).join(', '));
    } catch {
      this.health = null;
      return this.set('unavailable', undefined, makeError('unreachable', `Локальный сервис не отвечает по адресу ${this.endpoint()}.`));
    }
  }

  async translate(batch: TranslateRequest[], signal: AbortSignal): Promise<string[]> {
    try {
      const res = await this.fetchImpl(`${this.endpoint()}/translate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ texts: batch.map((r) => r.text) }),
        signal: withTimeout(signal, REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) throw makeError('bad-response', `Локальный сервис ответил кодом ${res.status}.`);
      const json: unknown = await res.json();
      const translations = isObject(json) ? json.translations : undefined;
      if (!Array.isArray(translations) || translations.length !== batch.length || !translations.every((t) => typeof t === 'string')) {
        throw makeError('bad-response', 'Локальный сервис вернул ответ неожиданного вида.');
      }
      this.noteSuccess();
      return translations as string[];
    } catch (e) {
      const raw = toError(e, 'unreachable');
      const error = raw.code === 'internal' ? makeError('unreachable', 'Локальный сервис не отвечает.') : raw;
      this.noteFailure(error, this.now());
      if (error.code === 'unreachable') this.set('unavailable', undefined, error);
      throw error;
    }
  }
}

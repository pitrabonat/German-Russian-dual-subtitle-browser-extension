// Contract between the translation engine and a provider (browser model, local service, Ollama).
import type { MitlesenError, ProviderId, ProviderStatus } from '../../shared/types';

export interface TranslateRequest {
  text: string;
  /** Preceding dialogue, oldest first. Providers that cannot use context ignore it. */
  before: string[];
  after: string[];
}

export interface TranslationProvider {
  readonly id: ProviderId;
  /** True when the output depends on the context lines. Decides cache keys and de-duplication. */
  readonly usesContext: boolean;
  /** `slow` providers (LLMs) get a provisional first answer from a `fast` one for on-screen subtitles. */
  readonly speed: 'fast' | 'slow';
  /** How many requests one call may carry during background preloading. */
  readonly batchSize: number;
  /** True when an in-flight call stops promptly on abort, so urgent work may preempt it. */
  readonly abortable: boolean;
  /** Identifies model and prompt for cache keys. */
  cacheTag(): string;
  /** Cheap, synchronous: may the engine send work right now? */
  usable(now: number): boolean;
  status(): ProviderStatus;
  /** Contacts the provider and refreshes its status. Never throws. */
  check(): Promise<ProviderStatus>;
  /** Translates the requests in order. Throws a MitlesenError on failure. */
  translate(batch: TranslateRequest[], signal: AbortSignal): Promise<string[]>;
  /** Optional: meaning of one word in its sentence. Only context-aware providers implement it. */
  wordInContext?(sentence: string, word: string, signal: AbortSignal): Promise<string>;
}

/** Shared health tracking: after failures a provider is skipped for a growing cool-down period. */
export abstract class ProviderHealth {
  protected failures = 0;
  protected retryAt = 0;
  protected lastError: MitlesenError | undefined;

  protected noteSuccess(): void {
    this.failures = 0;
    this.retryAt = 0;
    this.lastError = undefined;
  }

  protected noteFailure(error: MitlesenError, now: number): void {
    if (error.code === 'cancelled') return;
    this.failures++;
    this.lastError = error;
    // 4 s, 16 s, then one minute: quick recovery from a hiccup, no hammering of a dead endpoint.
    const delay = this.failures === 1 ? 4_000 : this.failures === 2 ? 16_000 : 60_000;
    this.retryAt = now + delay;
  }

  protected coolingDown(now: number): boolean {
    return now < this.retryAt;
  }
}

/** Combines an abort signal with a timeout. */
export function withTimeout(signal: AbortSignal, ms: number): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(ms)]);
}

// Browser-only provider: OPUS-MT (ONNX, int8) running in a Web Worker inside an offscreen
// document. Works without any local service.
import { makeError, toError, type OffscreenRequest, type OffscreenTranslateResponse } from '../../../shared/messages.ts';
import type { MitlesenError, ProviderStatus } from '../../../shared/types';
import { ProviderHealth, type TranslateRequest, type TranslationProvider } from '../provider.ts';

export const BROWSER_MODEL_ID = 'opus-mt-tc-big-de-zle';
const OFFSCREEN_PAGE = 'offscreen.html';
/** Covers reading 370 MB of model files from a slow disk plus session creation. */
const FIRST_CALL_TIMEOUT_MS = 240_000;
const CALL_TIMEOUT_MS = 60_000;

export class OpusBrowserProvider extends ProviderHealth implements TranslationProvider {
  readonly id = 'opus-browser' as const;
  readonly usesContext = false;
  readonly speed = 'fast' as const;
  readonly batchSize = 2;
  readonly abortable = false;

  private state: ProviderStatus['state'] = 'unknown';
  private detail: string | undefined;
  private error: MitlesenError | undefined;
  private progress: number | undefined;
  private modelPresent: boolean | null = null;
  private loaded = false;
  private creating: Promise<void> | null = null;
  private seq = 0;
  initMs: number | undefined;

  constructor(
    private readonly onChange: () => void = () => {},
    private readonly now: () => number = () => Date.now(),
  ) {
    super();
  }

  cacheTag(): string {
    return `${BROWSER_MODEL_ID}-q8`;
  }

  usable(now: number): boolean {
    return (this.state === 'ready' || this.state === 'loading') && !this.coolingDown(now);
  }

  status(): ProviderStatus {
    return { id: this.id, state: this.state, detail: this.detail, error: this.error, progress: this.progress };
  }

  private set(state: ProviderStatus['state'], detail?: string, error?: MitlesenError): ProviderStatus {
    const changed = state !== this.state || detail !== this.detail;
    this.state = state;
    this.detail = detail;
    this.error = error;
    if (state !== 'loading') this.progress = undefined;
    if (changed) this.onChange();
    return this.status();
  }

  /** Checks that the offscreen API exists and that the model files are part of this build. */
  async check(): Promise<ProviderStatus> {
    if (typeof chrome.offscreen?.createDocument !== 'function') {
      return this.set('unavailable', undefined, makeError('model-load', 'Этот браузер не поддерживает offscreen-документы; перевод в браузере недоступен.'));
    }
    if (this.modelPresent === null) {
      try {
        const res = await fetch(chrome.runtime.getURL(`models/${BROWSER_MODEL_ID}/config.json`), { method: 'HEAD' });
        this.modelPresent = res.ok;
      } catch {
        this.modelPresent = false;
      }
    }
    if (!this.modelPresent) {
      return this.set('unavailable', undefined, makeError('model-missing', 'В эту сборку расширения не включена модель перевода (облегчённый вариант).'));
    }
    if (this.state === 'loading') return this.status();
    return this.set('ready', this.loaded ? this.detail : 'модель загрузится при первом переводе');
  }

  /** Progress events relayed from the offscreen document. */
  handleProgress(progress: number): void {
    // Late events of a load that already failed must not revive the provider.
    if (this.loaded || this.state === 'error' || this.state === 'unavailable') return;
    this.progress = progress;
    this.state = 'loading';
    this.detail = 'загрузка модели';
    this.onChange();
  }

  private async ensureDocument(): Promise<void> {
    if (await chrome.offscreen.hasDocument()) return;
    this.creating ??= chrome.offscreen
      .createDocument({
        url: OFFSCREEN_PAGE,
        reasons: [chrome.offscreen.Reason.WORKERS],
        justification: 'Runs the translation model in a Web Worker.',
      })
      .catch((e: unknown) => {
        // A concurrent caller may have created it first.
        if (!String(e).includes('single offscreen')) throw e;
      })
      .finally(() => {
        this.creating = null;
      });
    await this.creating;
    this.loaded = false; // a fresh document has to load the model again
  }

  private async send(message: OffscreenRequest, timeoutMs: number): Promise<OffscreenTranslateResponse> {
    await this.ensureDocument();
    const deadline = this.now() + timeoutMs;
    // Right after creation the document may not listen yet; retry until it does.
    for (;;) {
      try {
        const response = (await Promise.race([
          chrome.runtime.sendMessage(message),
          new Promise((_, reject) => setTimeout(() => reject(makeError('timeout', 'Модель перевода не ответила вовремя.')), Math.max(1, deadline - this.now()))),
        ])) as OffscreenTranslateResponse | undefined;
        if (response) return response;
      } catch (e) {
        const error = toError(e);
        if (error.code === 'timeout' || !/Receiving end does not exist|message port closed/i.test(error.message)) throw error;
      }
      if (this.now() > deadline) throw makeError('timeout', 'Модель перевода не ответила вовремя.');
      await new Promise((r) => setTimeout(r, 120));
    }
  }

  async translate(batch: TranslateRequest[], _signal: AbortSignal): Promise<string[]> {
    try {
      if (!this.loaded && this.state !== 'loading') this.set('loading', 'загрузка модели');
      const response = await this.send(
        { target: 'offscreen', t: 'mt-translate', id: ++this.seq, texts: batch.map((r) => r.text) },
        this.loaded ? CALL_TIMEOUT_MS : FIRST_CALL_TIMEOUT_MS,
      );
      if (!response.ok || !response.translations || response.translations.length !== batch.length) {
        throw response.error ?? makeError('bad-response', 'Модель перевода вернула неполный ответ.');
      }
      this.loaded = true;
      if (response.initMs !== undefined) this.initMs = response.initMs;
      this.noteSuccess();
      this.set('ready', response.device);
      return response.translations;
    } catch (e) {
      const error = toError(e);
      this.noteFailure(error, this.now());
      this.set(error.code === 'model-load' ? 'error' : 'ready', this.detail, error);
      throw error;
    }
  }

  /** Starts loading the model without translating anything. */
  async warmUp(): Promise<void> {
    if (this.loaded) return;
    try {
      await this.send({ target: 'offscreen', t: 'mt-status' }, 10_000);
    } catch {
      /* the first translation will report the problem */
    }
  }

  /** Closes the offscreen document and frees the model memory. */
  async dispose(): Promise<void> {
    try {
      if (await chrome.offscreen.hasDocument()) await chrome.offscreen.closeDocument();
    } catch {
      /* already closed */
    }
    this.loaded = false;
  }
}

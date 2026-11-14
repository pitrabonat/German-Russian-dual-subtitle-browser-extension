// Ollama provider: context-aware translation with a local LLM.
import type { MitlesenError, ProviderStatus } from '../../../shared/types';
import { makeError, toError } from '../../../shared/messages.ts';
import { PROMPT_VERSION, buildChatRequest, buildWordRequest, cleanModelOutput, type OllamaChatRequest } from '../prompt.ts';
import { ProviderHealth, withTimeout, type TranslateRequest, type TranslationProvider } from '../provider.ts';

export interface OllamaConfig {
  endpoint: string;
  model: string;
  /** Ask Ollama to place every layer on the GPU instead of its conservative automatic split. */
  fullGpu: boolean;
}

interface OllamaChatResponse {
  message?: { content?: unknown };
  error?: unknown;
}

const REQUEST_TIMEOUT_MS = 45_000;
const CHECK_TIMEOUT_MS = 4_000;
/** Loading a multi-gigabyte model from a slow disk can take minutes. */
const WARMUP_TIMEOUT_MS = 15 * 60_000;

export class OllamaProvider extends ProviderHealth implements TranslationProvider {
  readonly id = 'ollama' as const;
  readonly usesContext = true;
  readonly speed = 'slow' as const;
  readonly batchSize = 1;
  readonly abortable = true;

  private state: ProviderStatus['state'] = 'unknown';
  private detail: string | undefined;
  private error: MitlesenError | undefined;
  private checkedAt = 0;
  private warming: Promise<void> | null = null;
  /** Cleared when the server reports that the model has no thinking switch. */
  private sendThinkFlag = true;
  private configKey = '';

  constructor(
    private readonly config: () => OllamaConfig,
    private readonly onChange: () => void = () => {},
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
    private readonly now: () => number = () => Date.now(),
  ) {
    super();
  }

  cacheTag(): string {
    return `${this.config().model}|p${PROMPT_VERSION}`;
  }

  usable(now: number): boolean {
    this.resetIfReconfigured();
    return this.state === 'ready' && !this.coolingDown(now);
  }

  status(): ProviderStatus {
    this.resetIfReconfigured();
    return { id: this.id, state: this.state, detail: this.detail, error: this.error, checkedAt: this.checkedAt || undefined };
  }

  private resetIfReconfigured(): void {
    const { endpoint, model, fullGpu } = this.config();
    const key = `${endpoint}|${model}|${fullGpu}`;
    if (key === this.configKey) return;
    this.configKey = key;
    this.state = 'unknown';
    this.detail = undefined;
    this.error = undefined;
    this.sendThinkFlag = true;
    this.noteSuccess();
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

  private async getJson(path: string, timeoutMs: number): Promise<unknown> {
    const res = await this.fetchImpl(`${this.config().endpoint}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (res.status === 403) throw makeError('forbidden', 'Ollama отклонила запрос расширения (403). Разрешите источник: OLLAMA_ORIGINS=chrome-extension://*');
    if (!res.ok) throw makeError('bad-response', `Ollama ответила кодом ${res.status}.`);
    return res.json();
  }

  /** Verifies reachability, model presence and whether the model is loaded; starts loading it if not. */
  async check(): Promise<ProviderStatus> {
    this.resetIfReconfigured();
    const { model } = this.config();
    try {
      const tags = (await this.getJson('/api/tags', CHECK_TIMEOUT_MS)) as { models?: { name?: string; model?: string }[] };
      const names = (tags.models ?? []).flatMap((m) => [m.name, m.model]).filter((n): n is string => typeof n === 'string');
      const wanted = model.includes(':') ? model : `${model}:latest`;
      if (!names.includes(wanted)) {
        return this.set('error', undefined, makeError('model-missing', `Модель ${model} не установлена. Выполните: ollama pull ${model}`));
      }
      const ps = (await this.getJson('/api/ps', CHECK_TIMEOUT_MS)) as { models?: { name?: string; model?: string; size?: number; size_vram?: number }[] };
      const loaded = (ps.models ?? []).find((m) => m.name === wanted || m.model === wanted);
      if (!loaded) {
        this.warmUp();
        return this.set('loading', `${model}: загружается в память`);
      }
      const share = loaded.size && loaded.size_vram !== undefined ? Math.round((100 * loaded.size_vram) / loaded.size) : null;
      this.noteSuccess();
      return this.set('ready', share === null ? model : `${model}, на видеокарте ${share}%`);
    } catch (e) {
      const error = toError(e, 'unreachable');
      if (error.code === 'forbidden') return this.set('error', undefined, error);
      if (error.code === 'bad-response') return this.set('error', undefined, error);
      return this.set('unavailable', undefined, makeError('unreachable', `Ollama не отвечает по адресу ${this.config().endpoint}.`));
    }
  }

  /** Loads the model into memory with an empty request, so translation calls never wait for it. */
  private warmUp(): void {
    if (this.warming) return;
    const { endpoint, model, fullGpu } = this.config();
    const body = { model, keep_alive: '20m', ...(fullGpu ? { options: { num_gpu: 99 } } : {}) };
    this.warming = this.fetchImpl(`${endpoint}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(WARMUP_TIMEOUT_MS),
    })
      .then(async (res) => {
        if (res.status === 403) throw makeError('forbidden', 'Ollama отклонила запрос расширения (403). Разрешите источник: OLLAMA_ORIGINS=chrome-extension://*');
        if (!res.ok) throw makeError('model-load', `Ollama не смогла загрузить ${model}: ${(await res.text()).slice(0, 200)}`);
        await res.json();
        await this.check();
      })
      .catch((e: unknown) => {
        this.set('error', undefined, toError(e, 'model-load'));
      })
      .finally(() => {
        this.warming = null;
      });
  }

  private async chat(request: OllamaChatRequest, signal: AbortSignal): Promise<string> {
    const { endpoint, fullGpu } = this.config();
    const body = fullGpu ? { ...request, options: { ...request.options, num_gpu: 99 } } : request;
    let res: Response;
    try {
      res = await this.fetchImpl(`${endpoint}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: withTimeout(signal, REQUEST_TIMEOUT_MS),
      });
    } catch (e) {
      const error = toError(e, 'unreachable');
      throw error.code === 'internal' ? makeError('unreachable', 'Ollama не отвечает.') : error;
    }
    if (res.status === 403) throw makeError('forbidden', 'Ollama отклонила запрос расширения (403).');
    if (!res.ok) {
      const text = (await res.text()).slice(0, 300);
      if (res.status === 400 && /does not support thinking/i.test(text) && request.think !== undefined) {
        this.sendThinkFlag = false;
        const { think: _think, ...withoutThink } = request;
        return this.chat(withoutThink, signal);
      }
      if (res.status === 404) throw makeError('model-missing', `Модель ${request.model} не найдена в Ollama.`);
      throw makeError('bad-response', `Ollama ответила кодом ${res.status}: ${text}`);
    }
    let json: OllamaChatResponse;
    try {
      json = (await res.json()) as OllamaChatResponse;
    } catch {
      throw makeError('bad-response', 'Ollama вернула не JSON.');
    }
    const content = json.message?.content;
    if (typeof content !== 'string') throw makeError('bad-response', 'В ответе Ollama нет текста.');
    return cleanModelOutput(content);
  }

  async translate(batch: TranslateRequest[], signal: AbortSignal): Promise<string[]> {
    const { model } = this.config();
    try {
      const out: string[] = [];
      for (const request of batch) out.push(await this.chat(buildChatRequest(model, request, this.sendThinkFlag), signal));
      this.noteSuccess();
      return out;
    } catch (e) {
      const error = toError(e);
      this.noteFailure(error, this.now());
      if (error.code === 'unreachable' || error.code === 'model-missing' || error.code === 'forbidden') this.set(error.code === 'unreachable' ? 'unavailable' : 'error', undefined, error);
      throw error;
    }
  }

  async wordInContext(sentence: string, word: string, signal: AbortSignal): Promise<string> {
    return this.chat(buildWordRequest(this.config().model, sentence, word, this.sendThinkFlag), signal);
  }
}

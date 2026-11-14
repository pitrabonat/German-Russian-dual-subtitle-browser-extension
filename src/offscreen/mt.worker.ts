// Web Worker that runs the OPUS-MT model with transformers.js (ONNX Runtime Web, WebAssembly).
// It lives inside the offscreen document, so model inference never touches a page's main thread.
import { env, pipeline } from '@huggingface/transformers';
import type { OffscreenTranslateResponse } from '../shared/messages';

export const MODEL_ID = 'opus-mt-tc-big-de-zle';

interface WorkerScope {
  postMessage(message: unknown): void;
  onmessage: ((event: MessageEvent) => void) | null;
  location: Location;
  crossOriginIsolated?: boolean;
}
const scope = self as unknown as WorkerScope;
const base = new URL('.', scope.location.href).href;

// Everything is loaded from the extension package. Nothing is fetched from the network.
env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = `${base}models/`;
env.useBrowserCache = false;
const wasm = env.backends.onnx.wasm;
if (wasm) {
  wasm.wasmPaths = `${base}ort/`;
  // Threads need SharedArrayBuffer, which the offscreen document gets through COOP/COEP.
  // Half of the logical cores, at most four: the video player needs the rest.
  const cores = navigator.hardwareConcurrency || 2;
  wasm.numThreads = scope.crossOriginIsolated ? Math.max(1, Math.min(4, Math.floor(cores / 2))) : 1;
}

type Translator = (texts: string[], options: Record<string, unknown>) => Promise<{ translation_text: string }[]>;

let translator: Promise<Translator> | null = null;
let initMs: number | undefined;

function load(): Promise<Translator> {
  if (translator) return translator;
  const started = performance.now();
  const totals = new Map<string, { loaded: number; total: number }>();
  translator = (
    pipeline('translation', MODEL_ID, {
      dtype: 'q8',
      device: 'wasm',
      progress_callback: (info: { status?: string; file?: string; loaded?: number; total?: number }) => {
        if (info.status !== 'progress' || !info.file || !info.total) return;
        totals.set(info.file, { loaded: info.loaded ?? 0, total: info.total });
        let loaded = 0;
        let total = 0;
        for (const t of totals.values()) {
          loaded += t.loaded;
          total += t.total;
        }
        scope.postMessage({ t: 'progress', progress: total > 0 ? loaded / total : 0, file: info.file });
      },
    }) as unknown as Promise<Translator>
  ).then((t) => {
    initMs = Math.round(performance.now() - started);
    return t;
  });
  translator.catch(() => {
    translator = null; // allow a retry after a failed load
  });
  return translator;
}

async function translate(texts: string[]): Promise<OffscreenTranslateResponse> {
  let run: Translator;
  try {
    run = await load();
  } catch (e) {
    return { ok: false, error: { code: 'model-load', message: `Не удалось загрузить модель перевода: ${e instanceof Error ? e.message : String(e)}` } };
  }
  try {
    const started = performance.now();
    // The model serves three East Slavic languages; the tag selects Russian.
    const outputs = await run(texts.map((t) => `>>rus<< ${t}`), { max_new_tokens: 256, num_beams: 1, do_sample: false });
    return {
      ok: true,
      translations: outputs.map((o) => o.translation_text),
      ms: Math.round(performance.now() - started),
      device: `WASM, потоков: ${wasm?.numThreads ?? 1}`,
      initMs,
    };
  } catch (e) {
    return { ok: false, error: { code: 'internal', message: `Ошибка модели перевода: ${e instanceof Error ? e.message : String(e)}` } };
  }
}

// One request at a time: the ONNX session is not re-entrant, and the engine already queues.
let chain: Promise<void> = Promise.resolve();
scope.onmessage = (event: MessageEvent) => {
  const data = event.data as { id?: number; texts?: string[]; t?: string };
  if (data.t === 'warmup') {
    chain = chain.then(async () => {
      await load().catch(() => undefined);
    });
    return;
  }
  if (typeof data.id !== 'number' || !Array.isArray(data.texts)) return;
  const { id, texts } = data;
  chain = chain.then(async () => {
    scope.postMessage({ t: 'result', id, response: await translate(texts) });
  });
};

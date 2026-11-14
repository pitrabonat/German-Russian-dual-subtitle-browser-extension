async function gpuInfo() {
  if (!('gpu' in navigator)) return { present: false };
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return { present: true, adapter: null };
    const info = adapter.info ?? {};
    return {
      present: true,
      vendor: info.vendor,
      architecture: info.architecture,
      device: info.device,
      description: info.description,
      f16: adapter.features.has('shader-f16'),
      fallback: adapter.isFallbackAdapter,
    };
  } catch (e) {
    return { present: true, error: String(e) };
  }
}

function workerProbe() {
  return new Promise((resolve) => {
    try {
      const src = 'postMessage({coi: self.crossOriginIsolated, sab: typeof SharedArrayBuffer, gpu: "gpu" in navigator})';
      const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
      w.onmessage = (e) => resolve(e.data);
      w.onerror = (e) => resolve({ error: e.message });
    } catch (e) {
      resolve({ error: String(e) });
    }
  });
}

const simd = WebAssembly.validate(new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11,
]));

async function translatorAvailability() {
  if (!('Translator' in self)) return 'api-missing';
  try {
    return await self.Translator.availability({ sourceLanguage: 'de', targetLanguage: 'ru' });
  } catch (e) {
    return 'error: ' + String(e);
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'offscreen-probe') return;
  (async () => {
    sendResponse({
      crossOriginIsolated: self.crossOriginIsolated,
      sharedArrayBuffer: typeof SharedArrayBuffer,
      hardwareConcurrency: navigator.hardwareConcurrency,
      deviceMemory: navigator.deviceMemory,
      wasmSimd: simd,
      worker: await workerProbe(),
      gpu: await gpuInfo(),
      translatorApi: await translatorAvailability(),
      languageDetectorApi: 'LanguageDetector' in self,
      cacheStorage: typeof caches,
    });
  })();
  return true;
});

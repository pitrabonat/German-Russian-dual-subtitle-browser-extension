// Offscreen document: hosts the translation worker. A service worker cannot create Web Workers
// and is shut down when idle, so the model lives here instead.
import { isOffscreenRequest, type OffscreenEvent, type OffscreenTranslateResponse } from '../shared/messages.ts';

/** The model (about 700 MB of RAM) is released after this much idle time. */
const IDLE_CLOSE_MS = 10 * 60_000;

const worker = new Worker(chrome.runtime.getURL('mt.worker.js'), { type: 'module' });
const pending = new Map<number, (response: OffscreenTranslateResponse) => void>();
let lastUse = Date.now();
let busy = 0;

function notify(event: OffscreenEvent): void {
  chrome.runtime.sendMessage(event).catch(() => {
    /* background is asleep; nothing to do */
  });
}

worker.onmessage = (event: MessageEvent) => {
  const data = event.data as { t: string; id?: number; progress?: number; file?: string; response?: OffscreenTranslateResponse };
  if (data.t === 'progress' && typeof data.progress === 'number') {
    notify({ target: 'background', t: 'mt-progress', progress: data.progress, file: data.file });
  } else if (data.t === 'result' && typeof data.id === 'number' && data.response) {
    pending.get(data.id)?.(data.response);
    pending.delete(data.id);
    busy = Math.max(0, busy - 1);
    lastUse = Date.now();
  }
};

worker.onerror = (event) => {
  const error = { code: 'model-load' as const, message: `Сбой рабочего потока перевода: ${event.message}` };
  for (const respond of pending.values()) respond({ ok: false, error });
  pending.clear();
  busy = 0;
};

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !isOffscreenRequest(message)) return undefined;
  lastUse = Date.now();
  switch (message.t) {
    case 'mt-translate':
      busy++;
      pending.set(message.id, sendResponse as (response: OffscreenTranslateResponse) => void);
      worker.postMessage({ id: message.id, texts: message.texts });
      return true; // answer later
    case 'mt-status':
      worker.postMessage({ t: 'warmup' });
      sendResponse({ ok: true });
      return undefined;
    case 'mt-dispose':
      sendResponse({ ok: true });
      window.close();
      return undefined;
  }
});

// While work is in flight, ping the background so that the browser keeps the service worker alive.
setInterval(() => {
  if (busy > 0) notify({ target: 'background', t: 'mt-keepalive' });
  else if (Date.now() - lastUse > IDLE_CLOSE_MS) window.close();
}, 15_000);

// Helpers shared by the browser tests.
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { launchBrowser, projectRoot, sleep } from './browser.mjs';
import { startServer } from './server.mjs';

export { sleep };
export const shotsDir = join(projectRoot, 'tests', 'results', 'screenshots');

/** Launches the browser with the built extension and enables it for the fixture server. */
export async function startSession({ browser = 'opera-gx', headless = true, profile, extensionPath } = {}) {
  mkdirSync(shotsDir, { recursive: true });
  const server = await startServer();
  const session = await launchBrowser({ browser, extensionPath: extensionPath ?? join(projectRoot, 'dist'), headless, profile: profile ?? `${browser}-e2e` });
  const target = await session.serviceWorkerTarget('background.js', 30000);
  const extensionId = new URL(target.url()).host;
  const worker = await target.worker();
  // Same call the popup makes for "Включить на этом сайте"; 127.0.0.1 is already a permitted host.
  await worker.evaluate(async (origin) => {
    await chrome.scripting.registerContentScripts([
      { id: 'e2e', matches: [`${origin}/*`], js: ['content.js'], allFrames: true, runAt: 'document_idle' },
      // The page-world half of the YouTube adapter, for the mock player page.
      { id: 'e2e-main', matches: [`${origin}/*`], js: ['youtube-main.js'], allFrames: true, runAt: 'document_start', world: 'MAIN' },
    ]);
  }, server.origin);
  return {
    ...session,
    server,
    extensionId,
    async sw(fn, ...args) {
      const t = await session.serviceWorkerTarget('background.js', 30000);
      return (await t.worker()).evaluate(fn, ...args);
    },
    async setSettings(patch) {
      const page = await session.browser.newPage();
      await page.goto(`chrome-extension://${extensionId}/popup.html`);
      await page.evaluate(async (p) => {
        const { settings = {} } = await chrome.storage.local.get('settings');
        await chrome.storage.local.set({ settings: { ...settings, ...p, appearance: { ...(settings.appearance ?? {}), ...(p.appearance ?? {}) } } });
      }, patch);
      await page.close();
    },
    async close() {
      await session.close();
      await server.close();
    },
  };
}

/** Reads what the overlay currently shows. */
export function readOverlay(page) {
  return page.evaluate(() => {
    const host = document.querySelector('#mitlesen-overlay');
    const root = host?.shadowRoot;
    if (!root) return null;
    const de = root.querySelector('.line.de');
    const ru = root.querySelector('.line.ru');
    const pop = root.querySelector('.pop');
    const chip = root.querySelector('.chip');
    return {
      de: de && !de.hidden ? de.textContent : '',
      ru: ru && !ru.hidden && !ru.classList.contains('pending') ? ru.textContent : '',
      pending: Boolean(ru && !ru.hidden && ru.classList.contains('pending')),
      words: Array.from(root.querySelectorAll('.w')).map((w) => w.textContent),
      stageHidden: root.querySelector('.stage')?.hidden ?? true,
      lift: Number.parseFloat(root.querySelector('.stage')?.style.getPropertyValue('--lift') || '0'),
      fontPx: Number.parseFloat(root.querySelector('.stage')?.style.getPropertyValue('--fs') || '0'),
      paused: document.querySelector('video')?.paused ?? true,
      popOpen: pop?.classList.contains('open') ?? false,
      popText: pop?.classList.contains('open') ? pop.innerText : '',
      linked: Array.from(root.querySelectorAll('.w.linked')).map((w) => w.textContent),
      chip: chip?.classList.contains('show') ? chip.textContent : '',
      time: document.querySelector('video')?.currentTime ?? -1,
    };
  });
}

/** Polls until `predicate(overlayState)` is truthy; returns the state or null on timeout. */
export async function waitOverlay(page, predicate, timeoutMs = 20000, stepMs = 100) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = await readOverlay(page);
    if (state && predicate(state)) return state;
    if (Date.now() > deadline) return null;
    await sleep(stepMs);
  }
}

/** Centre of the n-th word span whose text equals `word`, in page coordinates. */
export function wordCenter(page, word, nth = 0) {
  return page.evaluate(
    (w, n) => {
      const root = document.querySelector('#mitlesen-overlay')?.shadowRoot;
      const span = Array.from(root?.querySelectorAll('.w') ?? []).filter((s) => s.textContent === w)[n];
      if (!span) return null;
      const r = span.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    },
    word,
    nth,
  );
}

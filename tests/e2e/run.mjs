// Browser tests of the built extension. Run `npm run build` first.
//
//   node tests/e2e/run.mjs [--browser opera-gx|opera|edge|chrome] [--headed] [--only <text>]
//
// The tests drive a real browser with the unpacked extension from dist/ against local pages:
// an HTML5 player with WebVTT tracks and a stand-in for the YouTube player. Results and timings
// go to tests/results/e2e-<browser>.json, screenshots to tests/results/screenshots/.
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { projectRoot } from './browser.mjs';
import { readOverlay, shotsDir, sleep, startSession, waitOverlay, wordCenter } from './helpers.mjs';

const argv = process.argv.slice(2);
const flag = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const browserName = flag('--browser', 'opera-gx');
const headless = !argv.includes('--headed');
const only = flag('--only', '');
const T0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s]`, ...a);

const results = [];
const metrics = {};
const expect = (condition, message) => { if (!condition) throw new Error(message); };

async function scenario(name, fn) {
  if (only && !name.includes(only)) return;
  const started = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, ms: Date.now() - started, detail: detail ?? undefined });
    log('PASS', name, detail ? `(${String(detail).slice(0, 110)})` : '');
  } catch (e) {
    results.push({ name, ok: false, ms: Date.now() - started, detail: String(e.message ?? e).slice(0, 400) });
    log('FAIL', name, String(e.message ?? e).slice(0, 300));
  }
}

const LINE1 = 'Ich stehe jeden Morgen um sieben Uhr auf.';
const LINE5 = 'Die Kinder spielen draußen im Garten.';

/** Everything that needs one browser session with the given settings. */
async function withSession(options, body) {
  const s = await startSession({ browser: browserName, headless, ...options });
  const popup = await s.browser.newPage();
  await popup.goto(`chrome-extension://${s.extensionId}/popup.html`);
  const ctx = {
    s,
    popup,
    async open(path) {
      const page = await s.browser.newPage();
      await page.setViewport({ width: 1280, height: 800 });
      const t = Date.now();
      await page.goto(`${s.server.origin}/${path}`);
      await page.waitForSelector('#mitlesen-overlay', { timeout: 20000 });
      page.openedAt = t;
      return page;
    },
    /** Asks the content script of the test page (same request the popup sends). */
    ask(message) {
      return popup.evaluate(async (origin, msg) => {
        const tabs = (await chrome.tabs.query({})).filter((t) => t.url?.startsWith(origin));
        for (const tab of tabs.reverse()) {
          try {
            const answer = await chrome.tabs.sendMessage(tab.id, msg);
            if (answer) return answer;
          } catch { /* tab without content script */ }
        }
        return null;
      }, s.server.origin, message);
    },
    async waitState(predicate, timeoutMs = 20000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const state = await ctx.ask({ t: 'page-state' });
        if (state && predicate(state)) return state;
        if (Date.now() > deadline) return state;
        await sleep(200);
      }
    },
    async diagnostics() {
      const answer = await Promise.race([popup.evaluate(() => chrome.runtime.sendMessage({ t: 'diagnostics' })), sleep(20000).then(() => null)]);
      if (!answer?.diagnostics) throw new Error('the background worker did not answer the diagnostics request');
      return answer.diagnostics;
    },
    seek: (page, time, play = false) => page.evaluate((t, p) => { const v = document.querySelector('video'); v.currentTime = t; return p ? v.play() : v.pause(); }, time, play),
  };
  try {
    await body(ctx);
  } finally {
    await s.close();
  }
}

// ───────────────────────── session 1: defaults (model in the browser) ─────────────────────────

await withSession({ profile: `${browserName}-e2e` }, async (ctx) => {
  const { s, popup } = ctx;
  let page;

  await scenario('html5: German track is chosen among several', async () => {
    page = await ctx.open('player.html');
    const state = await ctx.waitState((st) => st.status.code === 'ready');
    metrics.subtitleExtractionMs = Date.now() - page.openedAt;
    expect(state?.status.code === 'ready', `status ${JSON.stringify(state?.status)}`);
    expect(state.adapter === 'html5' && state.cueCount === 16, `adapter ${state.adapter}, cues ${state.cueCount}`);
    expect(state.tracks.length === 2 && state.activeTrackId.includes('|de|'), `active ${state.activeTrackId}`);
    return `ready ${metrics.subtitleExtractionMs} ms after navigation`;
  });

  await scenario('html5: German line appears with interactive words', async () => {
    const t = Date.now();
    await ctx.seek(page, 0.9, true);
    const o = await waitOverlay(page, (x) => x.de.length > 0, 8000, 30);
    expect(o?.de === LINE1, `line "${o?.de}"`);
    expect(o.words.length === 8, `${o.words.length} word spans`);
    metrics.firstGermanLineMs = Date.now() - t;
    return `${metrics.firstGermanLineMs} ms after play()`;
  });

  await scenario('html5: Russian translation arrives from the browser model', async () => {
    const t = Date.now();
    const o = await waitOverlay(page, (x) => x.ru.length > 0 && /[а-яё]/i.test(x.ru), 240000, 200);
    expect(o, 'no translation within 240 s');
    metrics.firstTranslationMs = Date.now() - t;
    const d = await ctx.diagnostics();
    metrics.modelInitMs = d.metrics.find((m) => m.id === 'opus-browser')?.initMs;
    expect(d.activeProvider === 'opus-browser', `active provider ${d.activeProvider}`);
    return `${o.ru} | model init ${metrics.modelInitMs} ms`;
  });

  await scenario('html5: upcoming lines are translated ahead of playback', async () => {
    await ctx.seek(page, 12.5, false);
    // Give the queue time to work through the next few units.
    await sleep(9000);
    await ctx.seek(page, 14.7, true);
    let deAt = 0;
    let ruAt = 0;
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && !ruAt) {
      const o = await readOverlay(page);
      if (o?.de === LINE5) {
        deAt ||= Date.now();
        if (o.ru) ruAt = Date.now();
      }
      await sleep(25);
    }
    expect(deAt && ruAt, 'line 5 or its translation did not show');
    metrics.preloadedTranslationDelayMs = ruAt - deAt;
    expect(ruAt - deAt <= 150, `translation came ${ruAt - deAt} ms after the German line`);
    return `translation visible ${ruAt - deAt} ms after the German line`;
  });

  await scenario('html5: a sentence split over two cues gets one translation', async () => {
    await ctx.seek(page, 9, false);
    const a = await waitOverlay(page, (x) => x.de.startsWith('Ich habe gestern') && x.ru.length > 0, 20000);
    await ctx.seek(page, 12, false);
    const b = await waitOverlay(page, (x) => x.de.startsWith('den ich seit') && x.ru.length > 0, 20000);
    expect(a && b, 'fragments not shown');
    expect(a.ru === b.ru, `different translations: "${a.ru}" / "${b.ru}"`);
    await page.screenshot({ path: join(shotsDir, 'e2e-fragment.png') });
    return a.ru;
  });

  await scenario('html5: markup is removed, sound descriptions are not translated', async () => {
    await ctx.seek(page, 20, false);
    const a = await waitOverlay(page, (x) => x.de.startsWith('Kannst'), 8000);
    expect(a?.de === 'Kannst du mir bitte das Salz geben?', `line "${a?.de}"`);
    await ctx.seek(page, 37, false);
    const b = await waitOverlay(page, (x) => x.de === '[Musik]', 8000);
    await sleep(600);
    const c = await readOverlay(page);
    expect(b && c.ru === '' && !c.pending && c.words.length === 0, `non-speech cue: ${JSON.stringify(c).slice(0, 120)}`);
  });

  await scenario('html5: seeking shows the right line and its translation', async () => {
    await ctx.seek(page, 41, true);
    const o = await waitOverlay(page, (x) => x.de === 'Das Haus wird gerade renoviert.' && x.ru.length > 0, 20000);
    expect(o, `after seek: ${JSON.stringify(await readOverlay(page)).slice(0, 160)}`);
    return o.ru;
  });

  await scenario('html5: lines stay in sync at double speed', async () => {
    await page.evaluate(() => { const v = document.querySelector('video'); v.pause(); v.playbackRate = 2; v.currentTime = 14.2; return v.play(); });
    const o = await waitOverlay(page, (x) => x.de === LINE5, 6000, 15);
    await page.evaluate(() => { const v = document.querySelector('video'); v.pause(); v.playbackRate = 1; });
    expect(o, 'line 5 never appeared');
    metrics.cueLatenessAt2xVideoMs = Math.round((o.time - 15) * 1000);
    expect(o.time >= 15 && o.time < 15.4, `line appeared at video time ${o.time.toFixed(3)} (cue starts at 15.000)`);
    return `appeared at video time ${o.time.toFixed(3)} s`;
  });

  await scenario('html5: word panel opens on hover, links the detached prefix, pauses the video', async () => {
    await ctx.seek(page, 1.2, true);
    await waitOverlay(page, (x) => x.de === LINE1, 5000, 30);
    const c = await wordCenter(page, 'stehe');
    expect(c, 'word "stehe" not found');
    const t = Date.now();
    await page.mouse.move(c.x, c.y);
    const o = await waitOverlay(page, (x) => x.popOpen && x.popText.includes('aufstehen'), 6000, 15);
    metrics.popupOpenMs = Date.now() - t;
    expect(o, `panel: ${JSON.stringify(await readOverlay(page)).slice(0, 200)}`);
    expect(o.linked.includes('auf'), `linked words: ${o.linked}`);
    expect(o.popText.includes('stand auf') && o.popText.includes('aufgestanden'), 'principal parts missing');
    expect(o.paused, 'video was not paused while the panel is open');
    const inside = await page.evaluate(() => {
      const root = document.querySelector('#mitlesen-overlay').shadowRoot;
      const p = root.querySelector('.pop').getBoundingClientRect();
      const st = root.querySelector('.stage').getBoundingClientRect();
      return p.left >= st.left - 1 && p.right <= st.right + 1 && p.top >= st.top - 1 && p.bottom <= st.bottom + 1;
    });
    expect(inside, 'panel leaves the video area');
    await page.screenshot({ path: join(shotsDir, 'e2e-word-panel-verb.png') });
    await page.mouse.move(8, 8);
    const closed = await waitOverlay(page, (x) => !x.popOpen, 3000, 30);
    expect(closed && !closed.paused, 'panel did not close or playback did not resume');
    return `open after ${metrics.popupOpenMs} ms (includes the 90 ms hover delay)`;
  });

  await scenario('html5: click pins the panel, Escape closes it', async () => {
    await ctx.seek(page, 16, false);
    await waitOverlay(page, (x) => x.de === LINE5, 5000);
    const c = await wordCenter(page, 'Garten');
    await page.mouse.click(c.x, c.y);
    const o = await waitOverlay(page, (x) => x.popOpen && x.popText.includes('Garten'), 5000, 30);
    expect(o && /Dativ/.test(o.popText), `panel text: ${o?.popText.slice(0, 120)}`);
    await page.screenshot({ path: join(shotsDir, 'e2e-word-panel-noun.png') });
    await page.mouse.move(8, 8);
    await sleep(700);
    expect((await readOverlay(page)).popOpen, 'pinned panel closed on mouse leave');
    await page.keyboard.press('Escape');
    expect(await waitOverlay(page, (x) => !x.popOpen, 2000, 30), 'Escape did not close the panel');
  });

  await scenario('html5: a long line wraps inside the video', async () => {
    await ctx.seek(page, 24, false);
    await waitOverlay(page, (x) => x.de.startsWith('Obwohl') && x.ru.length > 0, 20000);
    const box = await page.evaluate(() => {
      const root = document.querySelector('#mitlesen-overlay').shadowRoot;
      const b = root.querySelector('.block').getBoundingClientRect();
      const st = root.querySelector('.stage').getBoundingClientRect();
      return { fits: b.left >= st.left && b.right <= st.right && b.top >= st.top && b.bottom <= st.bottom, share: b.width / st.width };
    });
    expect(box.fits && box.share <= 0.9, `block ${JSON.stringify(box)}`);
    await page.screenshot({ path: join(shotsDir, 'e2e-long-line.png') });
    return `block takes ${(box.share * 100).toFixed(0)}% of the width`;
  });

  await scenario('html5: switching the subtitle track', async () => {
    const state = await ctx.ask({ t: 'page-state' });
    const en = state.tracks.find((t) => t.language === 'en');
    const de = state.tracks.find((t) => t.language === 'de');
    await ctx.ask({ t: 'select-track', id: en.id });
    await ctx.seek(page, 2, false);
    const a = await waitOverlay(page, (x) => x.de === 'I get up at seven every morning.', 8000);
    expect(a, `after choosing English: "${(await readOverlay(page)).de}"`);
    await ctx.ask({ t: 'select-track', id: de.id });
    const b = await waitOverlay(page, (x) => x.de === LINE1, 8000);
    expect(b, 'German track did not come back');
  });

  await scenario('html5: fullscreen of the player wrapper keeps the overlay', async () => {
    await ctx.seek(page, 2, false);
    await page.click('#fs-wrap');
    await sleep(900);
    const fs = await page.evaluate(() => ({ el: document.fullscreenElement?.className ?? null, inside: Boolean(document.fullscreenElement?.contains(document.querySelector('#mitlesen-overlay'))) }));
    if (fs.el === null) return 'skipped: this browser mode refused fullscreen';
    const o = await readOverlay(page);
    await page.evaluate(() => document.exitFullscreen());
    await sleep(500);
    expect(fs.inside && o.de === LINE1, `fullscreen state ${JSON.stringify(fs)}, line "${o.de}"`);
  });

  await scenario('html5: fullscreen of the bare <video> falls back to native cues', async () => {
    await page.click('#fs-video');
    await sleep(900);
    const fs = await page.evaluate(() => {
      const v = document.querySelector('video');
      const track = Array.from(v.textTracks).find((t) => t.label === 'Mitlesen');
      return { el: document.fullscreenElement?.tagName ?? null, mode: track?.mode ?? null, text: track?.cues?.[0]?.text ?? '' };
    });
    if (fs.el === null) return 'skipped: this browser mode refused fullscreen';
    await page.evaluate(() => document.exitFullscreen());
    await sleep(500);
    expect(fs.el === 'VIDEO' && fs.mode === 'showing' && fs.text.startsWith(LINE1) && /\n.*[а-яё]/i.test(fs.text), `native cue: ${JSON.stringify(fs)}`);
    const after = await page.evaluate(() => Array.from(document.querySelector('video').textTracks).find((t) => t.label === 'Mitlesen')?.mode);
    expect(after === 'disabled', `fallback track still ${after} after fullscreen`);
  });

  await scenario('settings: appearance and visibility apply to an open video at once', async () => {
    await ctx.seek(page, 2, false);
    const before = await waitOverlay(page, (x) => x.de === LINE1 && x.ru.length > 0, 20000);
    await s.setSettings({ appearance: { fontScale: 6 } });
    const bigger = await waitOverlay(page, (x) => x.fontPx > before.fontPx * 1.3, 4000);
    expect(bigger, `font stayed at ${before.fontPx}px`);
    await s.setSettings({ showRussian: false });
    expect(await waitOverlay(page, (x) => x.ru === '' && x.de === LINE1, 4000), 'Russian line still visible');
    await s.setSettings({ showRussian: true, showGerman: false });
    expect(await waitOverlay(page, (x) => x.de === '' && x.ru.length > 0, 6000), 'German line still visible');
    await s.setSettings({ showGerman: true, wordPopup: false });
    expect(await waitOverlay(page, (x) => x.de === LINE1 && x.words.length === 0, 4000), 'words still interactive');
    await s.setSettings({ wordPopup: true, appearance: { fontScale: 3.6 } });
    await s.setSettings({ enabled: false });
    await sleep(600);
    const off = await page.evaluate(() => ({ overlay: Boolean(document.querySelector('#mitlesen-overlay')), mode: Array.from(document.querySelector('video').textTracks).find((t) => t.language === 'de')?.mode }));
    expect(!off.overlay && off.mode === 'disabled', `after disabling: ${JSON.stringify(off)}`);
    await s.setSettings({ enabled: true });
    expect(await waitOverlay(page, (x) => x.de === LINE1, 8000), 'overlay did not return after enabling');
  });

  await scenario('cache: a reloaded page gets its translations without the model', async () => {
    const before = await ctx.diagnostics();
    await page.reload();
    await page.waitForSelector('#mitlesen-overlay', { timeout: 15000 });
    await ctx.waitState((st) => st.status.code === 'ready');
    await ctx.seek(page, 0.9, true);
    let deAt = 0;
    let ruAt = 0;
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && !ruAt) {
      const o = await readOverlay(page);
      if (o?.de === LINE1) {
        deAt ||= Date.now();
        if (o.ru) ruAt = Date.now();
      }
      await sleep(20);
    }
    await ctx.seek(page, 2, false);
    const after = await ctx.diagnostics();
    expect(ruAt, 'no translation after reload');
    metrics.cachedTranslationDelayMs = ruAt - deAt;
    expect(after.cache.hits > before.cache.hits && after.cache.translations > 0, `cache hits ${before.cache.hits} -> ${after.cache.hits}`);
    expect(ruAt - deAt <= 250, `cached translation came after ${ruAt - deAt} ms`);
    return `${after.cache.translations} cached translations, shown ${ruAt - deAt} ms after the German line`;
  });

  await scenario('service worker restart: pending and new requests survive', async () => {
    // Terminate the worker the way the browser does after 30 s of inactivity. (Stopping it
    // through the ServiceWorker DevTools domain leaves it stuck in "starting" while a debugger is attached.)
    const target = await s.serviceWorkerTarget('background.js', 10000);
    await (await target.worker()).close();
    await sleep(800);
    expect(s.browser.targets().every((t) => !(t.type() === 'service_worker' && t.url().endsWith('/background.js'))), 'service worker is still running');
    // A line that was never requested: far beyond the preload window.
    await ctx.seek(page, 91, false);
    const o = await waitOverlay(page, (x) => x.de.startsWith('Der Zug hat') && x.ru.length > 0, 90000, 200);
    expect(o, `after restart: ${JSON.stringify(await readOverlay(page)).slice(0, 160)}`);
    return o.ru;
  });

  await scenario('missing subtitles are explained', async () => {
    const p = await ctx.open('no-subs.html');
    const state = await ctx.waitState((st) => st.status.code === 'no-subtitles', 10000);
    const o = await waitOverlay(p, (x) => x.chip.length > 0, 5000);
    await p.close();
    expect(state?.status.code === 'no-subtitles' && o?.chip.includes('нет субтитров'), `state ${JSON.stringify(state?.status)}, note "${o?.chip}"`);
    return state.status.detail;
  });

  // ── stand-in for the YouTube player ──

  let yt;
  await scenario('youtube: manual German track is requested through the player and intercepted', async () => {
    await page.close();
    yt = await ctx.open('youtube-mock.html');
    const state = await ctx.waitState((st) => st.status.code === 'ready');
    metrics.youtubeExtractionMs = Date.now() - yt.openedAt;
    expect(state?.status.code === 'ready', `status ${JSON.stringify(state?.status)}`);
    expect(state.adapter === 'youtube' && state.activeTrackId === 'de|' && state.cueCount === 16, `adapter ${state.adapter}, track ${state.activeTrackId}, cues ${state.cueCount}`);
    const dom = await yt.evaluate(() => ({
      inside: document.querySelector('#mitlesen-overlay')?.parentElement?.id,
      native: getComputedStyle(document.querySelector('.ytp-caption-window-container')).opacity,
      requests: window.timedtextRequests,
    }));
    expect(dom.inside === 'movie_player' && dom.native === '0' && dom.requests >= 1, JSON.stringify(dom));
    await ctx.seek(yt, 2, false);
    const o = await waitOverlay(yt, (x) => x.de === LINE1 && x.ru.length > 0, 20000);
    expect(o, 'line or translation missing');
    await yt.screenshot({ path: join(shotsDir, 'e2e-youtube-mock.png') });
    return `ready ${metrics.youtubeExtractionMs} ms after navigation`;
  });

  await scenario('youtube: the block moves above the player controls', async () => {
    await yt.evaluate(() => window.mock.controls(true));
    const up = await waitOverlay(yt, (x) => x.lift > 0, 3000);
    await yt.evaluate(() => window.mock.controls(false));
    const down = await waitOverlay(yt, (x) => x.lift === 0, 3000);
    expect(up && down, `lift ${up?.lift} / ${down?.lift}`);
    return `lifted by ${up.lift} px`;
  });

  await scenario('youtube: subtitles are hidden during an advertisement', async () => {
    await yt.evaluate(() => window.mock.ad(true));
    const hidden = await waitOverlay(yt, (x) => x.stageHidden, 3000);
    await yt.evaluate(() => window.mock.ad(false));
    const shown = await waitOverlay(yt, (x) => !x.stageHidden && x.de === LINE1, 3000);
    expect(hidden && shown, 'overlay did not follow the ad state');
  });

  await scenario('youtube: navigation to another video replaces the cues', async () => {
    await yt.evaluate(() => window.mock.navigate('video2'));
    await ctx.waitState((st) => st.status.code === 'ready' && st.cueCount === 16, 20000);
    await ctx.seek(yt, 2, false);
    const o = await waitOverlay(yt, (x) => x.de === 'Willkommen zum zweiten Video.', 10000);
    expect(o, `line after navigation: "${(await readOverlay(yt)).de}"`);
  });

  await scenario('youtube: automatic captions are read as separate lines', async () => {
    await ctx.ask({ t: 'select-track', id: 'de|asr' });
    const state = await ctx.waitState((st) => st.activeTrackId === 'de|asr' && st.status.code === 'ready', 20000);
    expect(state?.activeTrackId === 'de|asr' && state.cueCount > 16, `track ${state?.activeTrackId}, cues ${state?.cueCount}`);
    await ctx.seek(yt, 2, false);
    const o = await waitOverlay(yt, (x) => x.de.length > 0, 8000);
    expect(o && /^(willkommen|ich|zum)/.test(o.de) && !o.de.includes('\n'), `line "${o?.de}"`);
    return `${state.cueCount} lines; "${o.de}"`;
  });

  await scenario('youtube: choosing another language in the player hands control back', async () => {
    await yt.evaluate(() => window.mock.userPicks('en', ''));
    const state = await ctx.waitState((st) => st.status.code === 'no-german', 10000);
    const dom = await yt.evaluate(() => getComputedStyle(document.querySelector('.ytp-caption-window-container')).opacity);
    const o = await readOverlay(yt);
    expect(state?.status.code === 'no-german' && dom === '1' && o.de === '', `status ${state?.status.code}, native opacity ${dom}, overlay "${o.de}"`);
  });

  await scenario('youtube: videos without German or without any subtitles are reported', async () => {
    await yt.close();
    const a = await ctx.open('youtube-mock.html?v=nogerman');
    const noGerman = await ctx.waitState((st) => st.status.code === 'no-german', 15000);
    await a.close();
    const b = await ctx.open('youtube-mock.html?v=nosubs');
    const noSubs = await ctx.waitState((st) => st.status.code === 'no-subtitles', 25000);
    await b.close();
    expect(noGerman?.status.code === 'no-german' && noSubs?.status.code === 'no-subtitles', `${noGerman?.status.code} / ${noSubs?.status.code}`);
    return noGerman.status.detail;
  });

  await scenario('youtube: an empty subtitle response is explained, not ignored', async () => {
    const p = await ctx.open('youtube-mock.html?v=empty');
    const state = await ctx.waitState((st) => st.status.code === 'blocked', 30000);
    await p.close();
    expect(state?.status.code === 'blocked' && state.status.detail.includes('пустым'), `status ${JSON.stringify(state?.status)}`);
    return state.status.detail.slice(0, 80);
  });

  const d = await ctx.diagnostics();
  metrics.browserModel = d.metrics.find((m) => m.id === 'opus-browser');
  metrics.analysisLatency = d.analysisLatency;
  metrics.dictionary = d.dictionary;
});

// ───────────────────────── session 2: local mode without any local service ─────────────────────────

await withSession({ profile: `${browserName}-e2e-local` }, async (ctx) => {
  await scenario('local mode: with Ollama and the service down, the browser model takes over', async () => {
    await ctx.s.setSettings({ mode: 'local', localProvider: 'ollama', ollamaEndpoint: 'http://127.0.0.1:9', serviceEndpoint: 'http://127.0.0.1:9' });
    const page = await ctx.open('player.html');
    await ctx.waitState((st) => st.status.code === 'ready');
    await ctx.seek(page, 0.9, true);
    const o = await waitOverlay(page, (x) => x.ru.length > 0, 240000, 200);
    const d = await ctx.diagnostics();
    const state = Object.fromEntries(d.providers.map((p) => [p.id, `${p.state}: ${p.error?.message ?? p.detail ?? ''}`]));
    expect(o, 'no translation in local mode without services');
    expect(d.activeProvider === 'opus-browser' && d.providers.find((p) => p.id === 'ollama').state === 'unavailable' && d.providers.find((p) => p.id === 'local-service').state === 'unavailable', JSON.stringify(state));
    return JSON.stringify(state).slice(0, 200);
  });
});

// ───────────────────────── session 3: build without the bundled model ─────────────────────────

const lite = join(projectRoot, '.tmp', 'dist-lite');
if (!only || 'model files missing'.includes(only)) {
  rmSync(lite, { recursive: true, force: true });
  mkdirSync(lite, { recursive: true });
  cpSync(join(projectRoot, 'dist'), lite, { recursive: true, filter: (src) => !src.replace(/\\/g, '/').includes('/dist/models') });
  await withSession({ profile: `${browserName}-e2e-lite`, extensionPath: lite }, async (ctx) => {
    await scenario('model files missing: German subtitles keep working and the reason is shown', async () => {
      expect(!existsSync(join(lite, 'models')), 'lite copy still contains the model');
      const page = await ctx.open('player.html');
      await ctx.waitState((st) => st.status.code === 'ready');
      await ctx.seek(page, 0.9, true);
      const o = await waitOverlay(page, (x) => x.de === LINE1 && x.chip.length > 0, 20000);
      const d = await ctx.diagnostics();
      const provider = d.providers.find((p) => p.id === 'opus-browser');
      expect(o && o.ru === '', `overlay ${JSON.stringify(o ?? (await readOverlay(page))).slice(0, 300)} provider ${JSON.stringify(provider).slice(0, 300)}`);
      expect(provider.state === 'unavailable' && /модель/.test(provider.error?.message ?? ''), `provider ${JSON.stringify(provider)}`);
      const c = await wordCenter(page, 'stehe');
      await ctx.seek(page, 2, false);
      await page.mouse.move(c.x, c.y);
      expect(await waitOverlay(page, (x) => x.popOpen && x.popText.includes('aufstehen'), 6000), 'word panel does not work without the model');
      return o.chip;
    });
  });
}

const passed = results.filter((r) => r.ok).length;
const report = { browser: browserName, headless, date: new Date().toISOString(), passed, total: results.length, metrics, results };
mkdirSync(join(projectRoot, 'tests', 'results'), { recursive: true });
writeFileSync(join(projectRoot, 'tests', 'results', `e2e-${browserName}.json`), JSON.stringify(report, null, 1));
log(`${passed}/${results.length} passed`, JSON.stringify(metrics).slice(0, 600));
process.exitCode = passed === results.length ? 0 : 1;

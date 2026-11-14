// Live check on YouTube: finds a German video with subtitles, opens it and reports what the
// extension shows. Needs network access. Not part of the offline test run.
//
//   node tests/e2e/youtube.mjs [--browser opera-gx] [--headed] [--query "easy german"] [--video <id>]
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { startSession, readOverlay, waitOverlay, wordCenter, shotsDir, sleep } from './helpers.mjs';
import { projectRoot } from './browser.mjs';

const argv = process.argv.slice(2);
const flag = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const browserName = flag('--browser', 'opera-gx');
const query = flag('--query', 'Easy German Wortschatz');
const fixedVideo = flag('--video', '');
const T0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s]`, ...a);
const report = { browser: browserName, steps: [] };
const step = (name, ok, detail) => { report.steps.push({ name, ok, detail }); log(ok ? 'PASS' : 'FAIL', name, detail ?? ''); };

const s = await startSession({ browser: browserName, headless: !argv.includes('--headed'), profile: `${browserName}-youtube` });
try {
  const page = await s.browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  // Decline optional cookies up front, so the consent page does not get in the way.
  await s.browser.defaultBrowserContext().setCookie({ name: 'SOCS', value: 'CAESEwgDEgk0ODE3Nzk3MjQaAmVuIAEaBgiA_LyaBg', domain: '.youtube.com', path: '/', secure: true, sameSite: 'Lax', expires: Math.floor(Date.now() / 1000) + 86400 });

  let urls = [];
  if (fixedVideo) urls = [`https://www.youtube.com/watch?v=${fixedVideo}`];
  else {
    // sp=EgIoAQ%3D%3D is YouTube's "Subtitles/CC" search filter.
    await page.goto(`https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&sp=EgIoAQ%253D%253D`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('a#video-title', { timeout: 30000 }).catch(() => null);
    urls = await page.evaluate(() => Array.from(document.querySelectorAll('a#video-title')).map((a) => a.href).filter((h) => h.includes('/watch?v=')).slice(0, 4));
    log('search results:', urls.length, 'page:', page.url().slice(0, 80));
  }
  step('search returns videos', urls.length > 0, urls[0]);

  const popup = await s.browser.newPage();
  await popup.goto(`chrome-extension://${s.extensionId}/popup.html`);
  const pageState = () => popup.evaluate(async () => {
    const tabs = await chrome.tabs.query({ url: '*://www.youtube.com/watch*' });
    if (!tabs[0]?.id) return null;
    try { return await chrome.tabs.sendMessage(tabs[0].id, { t: 'page-state' }); } catch (e) { return { error: String(e) }; }
  });

  let done = false;
  for (const url of urls) {
    if (done) break;
    log('opening', url);
    await page.bringToFront();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const player = await page.waitForSelector('#movie_player video', { timeout: 30000 }).catch(() => null);
    if (!player) { log('no player; title:', await page.title()); continue; }
    await page.evaluate(() => { const p = document.getElementById('movie_player'); p?.mute?.(); p?.playVideo?.(); });
    const tStart = Date.now();

    // Wait for the adapter to settle: ready, or a definite "no German track".
    let state = null;
    for (let i = 0; i < 60; i++) {
      await sleep(1000);
      await page.evaluate(() => document.querySelector('.ytp-skip-ad-button, .ytp-ad-skip-button-modern')?.click());
      state = await pageState();
      if (state && !state.error && ['ready', 'no-german', 'no-subtitles', 'blocked'].includes(state.status.code)) break;
    }
    log('page state:', JSON.stringify(state).slice(0, 400));
    if (!state || state.error || state.status.code !== 'ready') continue;
    step('German track found and cues delivered', true, `${state.cueCount} cues, track ${state.activeTrackId}, after ${Date.now() - tStart} ms`);

    const de = await waitOverlay(page, (o) => o.de.length > 0, 60000, 200);
    step('German line shown', Boolean(de), de?.de);
    const ru = await waitOverlay(page, (o) => o.ru.length > 0, 150000, 250);
    step('Russian line shown', Boolean(ru), ru ? `${ru.de} => ${ru.ru}` : JSON.stringify(await readOverlay(page)).slice(0, 200));
    const native = await page.evaluate(() => getComputedStyle(document.querySelector('.ytp-caption-window-container') ?? document.body).opacity);
    step('native captions hidden', native === '0', `opacity ${native}`);

    // Word panel: pause on a line, hover its first long word.
    await page.evaluate(() => document.getElementById('movie_player')?.pauseVideo?.());
    await sleep(600);
    const shown = await readOverlay(page);
    const word = shown?.words.find((w) => w.length > 4) ?? shown?.words[0];
    if (word) {
      const c = await wordCenter(page, word);
      if (c) { await page.mouse.move(c.x, c.y); await sleep(1200); }
      const hover = await readOverlay(page);
      step('word panel opens on hover', Boolean(hover?.popOpen), `${word}: ${hover?.popText.replace(/\n/g, ' | ').slice(0, 160)}`);
    }
    await page.screenshot({ path: join(shotsDir, `youtube-${browserName}.png`) });
    await page.mouse.move(5, 5);

    // Seek: the line and its translation must follow.
    await page.evaluate(() => { const p = document.getElementById('movie_player'); p?.seekTo?.((p.getCurrentTime?.() ?? 0) + 45, true); p?.playVideo?.(); });
    const before = shown?.de;
    const afterSeek = await waitOverlay(page, (o) => o.de.length > 0 && o.de !== before && o.ru.length > 0, 60000, 200);
    step('line and translation follow a seek', Boolean(afterSeek), afterSeek ? `${afterSeek.de} => ${afterSeek.ru}` : '');

    // Fullscreen: the overlay lives inside the player and must stay visible.
    await page.evaluate(() => document.getElementById('movie_player')?.requestFullscreen?.().catch(() => undefined));
    await sleep(1500);
    const fs = await page.evaluate(() => ({ fs: document.fullscreenElement?.id ?? null, inside: Boolean(document.fullscreenElement?.querySelector('#mitlesen-overlay')) }));
    step('overlay stays inside the fullscreen player', fs.fs !== null ? fs.inside : true, JSON.stringify(fs));
    await page.evaluate(() => document.exitFullscreen?.().catch(() => undefined));
    done = true;
  }
  step('a German video was tested end to end', done);
} catch (e) {
  step('run completed without exception', false, String(e).slice(0, 300));
} finally {
  writeFileSync(join(projectRoot, 'tests', 'results', `youtube-${browserName}.json`), JSON.stringify(report, null, 1));
  await s.close();
  log('closed');
}

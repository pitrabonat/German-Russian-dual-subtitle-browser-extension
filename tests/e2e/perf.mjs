// Memory and CPU of the browser model, measured on the processes of a throwaway browser profile.
//
//   node tests/e2e/perf.mjs [--browser opera-gx|chrome] [--headed]
//
// 1. baseline: the test page plays, the extension shows German lines, the model is not loaded;
// 2. after the first translation: the offscreen document holds the model;
// 3. steady playback for 30 s with translation ahead of playback, then 30 s with everything cached.
// Writes tests/results/perf-<browser>.json.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { join } from 'node:path';
import { projectRoot } from './browser.mjs';
import { sleep, startSession, waitOverlay } from './helpers.mjs';

const argv = process.argv.slice(2);
const browserName = argv.includes('--browser') ? argv[argv.indexOf('--browser') + 1] : 'opera-gx';
const headless = !argv.includes('--headed');
// --extension <dir>: another build, e.g. .tmp/dist-lite (no model) as the baseline for the model's memory.
const extensionPath = argv.includes('--extension') ? join(projectRoot, argv[argv.indexOf('--extension') + 1]) : undefined;
const tag = extensionPath ? 'lite' : 'full';

/** Sum over the processes started with the profile: working set, private bytes, CPU seconds. */
function sample(profileDir) {
  const marker = profileDir.replace(/'/g, "''");
  const ps = `$p = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${marker}*' }; ` +
    `$o = @{ n = @($p).Count; ws = ($p | Measure-Object WorkingSetSize -Sum).Sum; priv = ($p | Measure-Object PrivatePageCount -Sum).Sum; ` +
    `cpu = (($p | Measure-Object UserModeTime -Sum).Sum + ($p | Measure-Object KernelModeTime -Sum).Sum) / 1e7; ` +
    `top = @($p | Sort-Object PrivatePageCount -Descending | Select-Object -First 3 | ForEach-Object { [math]::Round($_.PrivatePageCount / 1MB) }) }; $o | ConvertTo-Json -Compress`;
  const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8' });
  const j = JSON.parse(out);
  return { processes: j.n, workingSetMb: Math.round(j.ws / 2 ** 20), privateMb: Math.round(j.priv / 2 ** 20), cpuSeconds: j.cpu, largestPrivateMb: j.top, at: Date.now() };
}

const cpuShare = (a, b) => +((100 * (b.cpuSeconds - a.cpuSeconds)) / ((b.at - a.at) / 1000) / cpus().length).toFixed(1);

const s = await startSession({ browser: browserName, headless, profile: `${browserName}-perf`, extensionPath });
const report = { browser: browserName, build: tag, headless, logicalCores: cpus().length, date: new Date().toISOString() };
try {
  const page = await s.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  await page.goto(`${s.server.origin}/player.html`);
  await page.waitForSelector('#mitlesen-overlay', { timeout: 20000 });
  await page.evaluate(() => { const v = document.querySelector('video'); v.loop = true; v.muted = true; v.currentTime = 0.5; return v.play(); });
  await waitOverlay(page, (x) => x.de.length > 0, 20000);
  await sleep(3000);
  const base = sample(s.profileDir);
  console.log('baseline', base);

  const t0 = Date.now();
  const translated = tag === 'full' ? await waitOverlay(page, (x) => x.ru.length > 0, 240000, 250) : true;
  if (tag === 'full') report.firstTranslationMs = Date.now() - t0;
  if (!translated) throw new Error('no translation within 4 minutes');
  await sleep(2000);
  const loaded = sample(s.profileDir);
  console.log('model loaded', loaded);

  const a = sample(s.profileDir);
  await sleep(30000);
  const b = sample(s.profileDir);
  await sleep(30000);
  const c = sample(s.profileDir);
  console.log('after 60 s of playback', c);

  report.baseline = base;
  report.modelLoaded = loaded;
  report.modelMemoryMb = { workingSet: loaded.workingSetMb - base.workingSetMb, private: loaded.privateMb - base.privateMb };
  report.cpuPercentOfAllCores = { translatingAhead: cpuShare(a, b), cachedPlayback: cpuShare(b, c) };
  report.end = c;
} finally {
  await s.close();
}
mkdirSync(join(projectRoot, 'tests', 'results'), { recursive: true });
writeFileSync(join(projectRoot, 'tests', 'results', `perf-${browserName}-${tag}.json`), JSON.stringify(report, null, 1));
console.log(JSON.stringify({ modelMemoryMb: report.modelMemoryMb, cpu: report.cpuPercentOfAllCores, firstTranslationMs: report.firstTranslationMs }));

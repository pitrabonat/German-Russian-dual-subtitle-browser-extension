// Runs the API probe extension in every installed Chromium-based browser and stores the results
// in tests/results/api-probe.json.
// Usage: node tools/probe.mjs [opera-gx|opera|edge|chrome ...] [--headed]
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launchBrowser, evalInServiceWorker, findBrowser, projectRoot } from '../tests/e2e/browser.mjs';

const argv = process.argv.slice(2);
const headless = !argv.includes('--headed');
const wanted = argv.filter((a) => !a.startsWith('--'));
const browsers = (wanted.length ? wanted : ['opera-gx', 'opera', 'edge', 'chrome']).filter((b) => findBrowser(b));

const results = {};
for (const name of browsers) {
  let session;
  try {
    session = await launchBrowser({ browser: name, extensionPath: join(projectRoot, 'tools', 'probe-extension'), headless, profile: `${name}-probe` });
    const version = await session.browser.version();
    const report = await evalInServiceWorker(session, () => self.probe(), { file: 'sw.js' });
    results[name] = { exe: session.exe, version, headless, report };
  } catch (e) {
    results[name] = { error: String(e) };
  } finally {
    await session?.close();
  }
}
mkdirSync(join(projectRoot, 'tests', 'results'), { recursive: true });
writeFileSync(join(projectRoot, 'tests', 'results', 'api-probe.json'), JSON.stringify(results, null, 2));
const brief = Object.fromEntries(Object.entries(results).map(([k, v]) => [k, v.error ?? {
  version: v.version,
  brands: v.report.brands?.join(', '),
  offscreen: v.report.offscreen?.created === true,
  offscreenIsolated: v.report.offscreen?.report?.crossOriginIsolated,
  workerInOffscreen: v.report.offscreen?.report?.worker,
  gpu: v.report.offscreen?.report?.gpu,
  translatorApi: v.report.offscreen?.report?.translatorApi,
  dnr: v.report.dnr,
  swWorker: v.report.sw.worker,
  sidePanel: v.report.apis.sidePanel,
}]));
console.log(JSON.stringify(brief, null, 1));

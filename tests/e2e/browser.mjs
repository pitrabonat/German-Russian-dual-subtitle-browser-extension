// Launches a Chromium-based browser (Opera GX, Opera, Edge, Chrome) with an unpacked extension.
//
// Opera GX 139 (Chromium 155) ignores the --load-extension switch, like branded Chrome 137+.
// The extension is therefore installed through the DevTools pipe (Extensions.loadUnpacked),
// which puppeteer does when `enableExtensions` is a list of paths. This also works headless.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const here = dirname(fileURLToPath(import.meta.url));
export const projectRoot = resolve(here, '..', '..');

const env = process.env;
const local = env.LOCALAPPDATA ?? '';
const pf = env.ProgramFiles ?? 'C:\\Program Files';
const pf86 = env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';

function newestVersionedBinary(dir, exe) {
  if (!existsSync(dir)) return null;
  const versions = readdirSync(dir)
    .filter((n) => /^\d+\.\d+\.\d+\.\d+$/.test(n) && existsSync(join(dir, n, exe)))
    .sort((a, b) => {
      const pa = a.split('.').map(Number);
      const pb = b.split('.').map(Number);
      for (let i = 0; i < 4; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
      return 0;
    });
  const last = versions.at(-1);
  return last ? join(dir, last, exe) : null;
}

/** Returns the path of the requested browser or null when it is not installed. */
export function findBrowser(name) {
  // Opera keeps the real binary in a versioned folder; the top-level opera.exe is only a launcher.
  const candidates = {
    'opera-gx': [newestVersionedBinary(join(local, 'Programs', 'Opera GX'), 'opera.exe')],
    opera: [newestVersionedBinary(join(local, 'Programs', 'Opera'), 'opera.exe'), newestVersionedBinary(join(pf, 'Opera'), 'opera.exe')],
    edge: [join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe')],
    chrome: [join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'), join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'), join(local, 'Google', 'Chrome', 'Application', 'chrome.exe')],
  }[name];
  if (!candidates) throw new Error(`Unknown browser "${name}"`);
  return candidates.find((p) => p && existsSync(p)) ?? null;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {object} o
 * @param {'opera-gx'|'opera'|'edge'|'chrome'} o.browser
 * @param {string} [o.extensionPath] unpacked extension directory
 * @param {boolean} [o.headless] defaults to true
 * @param {string} [o.profile] profile folder name under .tmp/profiles (wiped unless keepProfile)
 * @param {boolean} [o.keepProfile]
 * @param {string[]} [o.extraArgs]
 */
export async function launchBrowser(o) {
  const exe = findBrowser(o.browser);
  if (!exe) throw new Error(`${o.browser} is not installed`);
  const profileDir = join(projectRoot, '.tmp', 'profiles', o.profile ?? `${o.browser}-e2e`);
  if (!o.keepProfile) rmSync(profileDir, { recursive: true, force: true });
  mkdirSync(profileDir, { recursive: true });
  const extensionPath = o.extensionPath ? resolve(o.extensionPath) : null;

  const browser = await puppeteer.launch({
    executablePath: exe,
    pipe: true,
    headless: o.headless ?? true,
    userDataDir: profileDir,
    enableExtensions: extensionPath ? [extensionPath] : false,
    defaultViewport: null,
    protocolTimeout: 600_000,
    args: [
      '--no-first-run',
      '--no-default-browser-check',
      '--mute-audio',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--window-size=1280,860',
      ...(o.extraArgs ?? []),
    ],
  });

  /** Waits for the service worker of the extension under test (Opera has built-in ones too). */
  async function serviceWorkerTarget(file = 'background.js', timeoutMs = 20000) {
    return browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith(`/${file}`), { timeout: timeoutMs });
  }

  async function close() {
    try { await browser.close(); } catch { /* already gone */ }
    await sleep(300);
    killByProfile(profileDir);
  }

  return { browser, exe, profileDir, serviceWorkerTarget, close };
}

/** Kills only the processes that were started with our throwaway profile directory. */
export function killByProfile(profileDir) {
  const marker = profileDir.replace(/'/g, "''");
  const ps = `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${marker}') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { stdio: 'ignore' });
  } catch { /* nothing to kill */ }
}

/** Evaluates a function in the extension service worker. */
export async function evalInServiceWorker(session, fn, { file = 'background.js', args = [] } = {}) {
  const target = await session.serviceWorkerTarget(file);
  const worker = await target.worker();
  if (!worker) throw new Error('service worker target has no worker handle');
  return worker.evaluate(fn, ...args);
}

export function extensionIdOf(target) {
  return new URL(target.url()).host;
}

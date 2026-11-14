// Runs in the page's own JavaScript world on Netflix (manifest: "world": "MAIN", document_start).
//
// The Netflix player receives a playback manifest that lists every subtitle track with the
// addresses of its text files. The video itself is DRM-protected; the subtitle files are not:
// they are plain WebVTT/TTML that the player downloads and draws as text. This script only
// looks at the manifest after the player has parsed it, and passes the track list to the
// content script. Nothing is modified, no request is sent from here.
import { extractNetflixManifest, type NetflixManifest } from './netflix-manifest.ts';

const CHANNEL = 'mitlesen';
const pageOrigin = location.origin;
/** Manifests seen so far (the content script may start later than the player). */
const seen: NetflixManifest[] = [];

function post(type: string, payload: Record<string, unknown>): void {
  window.postMessage({ channel: CHANNEL, from: 'main', type, ...payload }, pageOrigin);
}

function inspect(value: unknown): void {
  // Cheap rejection first: JSON.parse runs very often on this site.
  if (typeof value !== 'object' || value === null) return;
  const v = value as { result?: unknown; timedtexttracks?: unknown };
  if (v.timedtexttracks === undefined && (typeof v.result !== 'object' || v.result === null)) return;
  const manifest = extractNetflixManifest(value);
  if (!manifest) return;
  seen.push(manifest);
  if (seen.length > 8) seen.shift();
  post('nf-manifest', { manifest });
}

const originalParse = JSON.parse;
JSON.parse = function (this: unknown, text: string, reviver?: (this: unknown, key: string, value: unknown) => unknown): unknown {
  const value: unknown = originalParse.call(this, text, reviver);
  try {
    inspect(value);
  } catch {
    /* never disturb the page */
  }
  return value;
} as typeof JSON.parse;

const originalJson = Response.prototype.json;
Response.prototype.json = function (this: Response): Promise<unknown> {
  const promise = originalJson.call(this) as Promise<unknown>;
  void promise.then(
    (value) => {
      try {
        inspect(value);
      } catch {
        /* never disturb the page */
      }
    },
    () => undefined,
  );
  return promise;
};

window.addEventListener('message', (event: MessageEvent) => {
  if (event.source !== window || event.origin !== pageOrigin) return;
  const data = event.data as { channel?: string; from?: string; type?: string; id?: number } | null;
  if (!data || data.channel !== CHANNEL || data.from !== 'content') return;
  if (data.type === 'nf-list') post('nf-manifests', { id: data.id, manifests: seen });
});

post('hello', {});

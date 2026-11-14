// Runs in the page's own JavaScript world on YouTube (manifest: "world": "MAIN").
//
// It does two things the isolated content script cannot do:
//  1. observe the player's own subtitle requests (/api/timedtext) and pass the responses on;
//  2. talk to the player API (list caption tracks, switch the track).
//
// Reading the player's own responses is the reliable way to get subtitles: the request carries
// tokens the player computes itself, so the same URL fetched from elsewhere may come back empty.
// Nothing is modified and no protection is bypassed: we read what the page has already loaded.

interface PlayerTrack {
  languageCode?: string;
  languageName?: string;
  displayName?: string;
  kind?: string;
  vss_id?: string;
}

interface YouTubePlayer extends HTMLElement {
  getOption?(module: string, option: string, params?: unknown): unknown;
  setOption?(module: string, option: string, value: unknown): void;
  loadModule?(module: string): void;
  getVideoData?(): { video_id?: string } | undefined;
  getPlayerResponse?(): unknown;
}

const CHANNEL = 'mitlesen';
const pageOrigin = location.origin;

function post(type: string, payload: Record<string, unknown>): void {
  window.postMessage({ channel: CHANNEL, from: 'main', type, ...payload }, pageOrigin);
}

function isTimedText(url: string): boolean {
  return url.includes('/api/timedtext');
}

function absolute(url: string): string {
  try {
    return new URL(url, location.href).href;
  } catch {
    return url;
  }
}

// ── 1. Observe subtitle responses ──

const originalOpen = XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]): void {
  const href = typeof url === 'string' ? url : url.href;
  if (isTimedText(href)) {
    this.addEventListener('load', () => {
      try {
        if (this.status === 200 && (this.responseType === '' || this.responseType === 'text')) {
          post('timedtext', { url: absolute(href), body: this.responseText });
        }
      } catch {
        /* never disturb the page */
      }
    });
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (originalOpen as any).call(this, method, url, ...rest);
};

const originalFetch = window.fetch;
window.fetch = function (this: unknown, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const promise = originalFetch.call(this, input, init);
  try {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (isTimedText(href)) {
      void promise
        .then((response) => (response.ok ? response.clone().text() : null))
        .then((body) => {
          if (body) post('timedtext', { url: absolute(href), body });
        })
        .catch(() => undefined);
    }
  } catch {
    /* never disturb the page */
  }
  return promise;
};

// ── 2. Player API bridge ──

function player(): YouTubePlayer | null {
  const el = document.getElementById('movie_player') ?? document.querySelector('.html5-video-player');
  return (el as YouTubePlayer | null) ?? null;
}

function captionTracksFromResponse(p: YouTubePlayer): PlayerTrack[] {
  const response = p.getPlayerResponse?.() as
    | { captions?: { playerCaptionsTracklistRenderer?: { captionTracks?: { languageCode?: string; kind?: string; vssId?: string; name?: { simpleText?: string; runs?: { text?: string }[] } }[] } } }
    | undefined;
  const tracks = response?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  return tracks.map((t) => ({
    languageCode: t.languageCode,
    kind: t.kind,
    vss_id: t.vssId,
    displayName: t.name?.simpleText ?? t.name?.runs?.map((r) => r.text ?? '').join('') ?? t.languageCode,
  }));
}

function listTracks(): { tracks: PlayerTrack[]; active: PlayerTrack | null; videoId: string | null; ready: boolean } {
  const p = player();
  if (!p || typeof p.getOption !== 'function') return { tracks: [], active: null, videoId: null, ready: false };
  let tracks: PlayerTrack[] = [];
  let active: PlayerTrack | null = null;
  try {
    const list = p.getOption('captions', 'tracklist', { includeAsr: true });
    if (Array.isArray(list)) tracks = list as PlayerTrack[];
    const current = p.getOption('captions', 'track');
    if (current && typeof current === 'object' && (current as PlayerTrack).languageCode) active = current as PlayerTrack;
  } catch {
    /* captions module not loaded yet */
  }
  if (tracks.length === 0) {
    try {
      tracks = captionTracksFromResponse(p);
    } catch {
      /* player response not available */
    }
  }
  const plain = (t: PlayerTrack): PlayerTrack => ({
    languageCode: t.languageCode,
    languageName: t.languageName,
    displayName: t.displayName,
    kind: t.kind,
    vss_id: t.vss_id,
  });
  return { tracks: tracks.map(plain), active: active ? plain(active) : null, videoId: p.getVideoData?.()?.video_id ?? null, ready: true };
}

function setTrack(track: { languageCode: string; kind?: string; vss_id?: string } | null): boolean {
  const p = player();
  if (!p || typeof p.setOption !== 'function') return false;
  try {
    p.loadModule?.('captions');
    p.setOption('captions', 'track', track ?? {});
    return true;
  } catch {
    return false;
  }
}

window.addEventListener('message', (event: MessageEvent) => {
  if (event.source !== window || event.origin !== pageOrigin) return;
  const data = event.data as { channel?: string; from?: string; type?: string; id?: number; track?: { languageCode: string; kind?: string; vss_id?: string } | null } | null;
  if (!data || data.channel !== CHANNEL || data.from !== 'content') return;
  if (data.type === 'list-tracks') post('tracks', { id: data.id, ...listTracks() });
  else if (data.type === 'set-track') post('track-set', { id: data.id, ok: setTrack(data.track ?? null) });
});

// The player announces API changes (for example when the captions module finishes loading).
document.addEventListener('yt-navigate-finish', () => post('navigated', {}), true);
window.addEventListener('load', () => post('navigated', {}), { once: true });
post('hello', {});

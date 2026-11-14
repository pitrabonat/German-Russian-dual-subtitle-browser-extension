// Reads the subtitle track list out of a Netflix playback manifest. Shared by the page-world
// hook (src/inject/netflix-main.ts) and the unit tests. The manifest format is not public and
// changes over time, so the reader only relies on a few long-lived names (timedtexttracks,
// ttDownloadables, language) and collects URLs from whatever shape the downloadables have.

export interface NetflixTrack {
  id: string;
  language: string;
  label: string;
  /** "subtitles", "closedcaptions", … as Netflix calls it. */
  kind: string;
  forced: boolean;
  /** Text files by profile, best profile first. Image-only tracks have none. */
  files: { profile: string; url: string }[];
  imageOnly: boolean;
}

export interface NetflixManifest {
  movieId: string | null;
  tracks: NetflixTrack[];
}

/** Text profiles, most convenient first. "nflx-cmisc" and friends are image subtitles. */
const TEXT_PROFILES = ['webvtt-lssdh-ios8', 'dfxp-ls-sdh', 'simplesdh', 'imsc1.1'];
const IMAGE_PROFILE = /cmisc|image|png/i;
const MAX_TRACKS = 200;
const MAX_URL = 4000;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');

function urlsOf(downloadable: unknown): string[] {
  const out: string[] = [];
  const add = (v: unknown): void => {
    const s = isObj(v) ? str(v.url) : str(v);
    if (/^https?:\/\//.test(s) && s.length <= MAX_URL && !out.includes(s)) out.push(s);
  };
  if (!isObj(downloadable)) return out;
  // Older manifests: downloadUrls: { "<cdn id>": "https://…" }; newer: urls: [{ cdn_id, url }].
  if (isObj(downloadable.downloadUrls)) Object.values(downloadable.downloadUrls).forEach(add);
  if (Array.isArray(downloadable.urls)) downloadable.urls.forEach(add);
  return out;
}

function readTrack(raw: unknown, index: number): NetflixTrack | null {
  if (!isObj(raw) || raw.isNoneTrack === true) return null;
  const language = str(raw.language) || str(raw.bcp47);
  if (!language) return null;
  const files: { profile: string; url: string }[] = [];
  let sawImage = false;
  const downloadables = isObj(raw.ttDownloadables) ? raw.ttDownloadables : {};
  const profiles = Object.keys(downloadables).sort((a, b) => rank(a) - rank(b));
  for (const profile of profiles) {
    const d = downloadables[profile];
    if (IMAGE_PROFILE.test(profile) || (isObj(d) && d.isImage === true)) {
      sawImage = true;
      continue;
    }
    for (const url of urlsOf(d)) files.push({ profile, url });
  }
  return {
    id: str(raw.new_track_id) || str(raw.id) || `${language}|${str(raw.rawTrackType)}|${index}`,
    language,
    label: str(raw.languageDescription) || language,
    kind: str(raw.rawTrackType) || str(raw.trackType) || 'subtitles',
    forced: raw.isForcedNarrative === true,
    files,
    imageOnly: files.length === 0 && sawImage,
  };
}

function rank(profile: string): number {
  const i = TEXT_PROFILES.indexOf(profile);
  return i < 0 ? TEXT_PROFILES.length : i;
}

/** Finds a manifest in a parsed JSON value: the object itself, `.result`, or the first element of `.result`. */
export function extractNetflixManifest(value: unknown): NetflixManifest | null {
  if (!isObj(value)) return null;
  const candidates: unknown[] = [value, value.result];
  if (Array.isArray(value.result)) candidates.push(value.result[0]);
  for (const c of candidates) {
    if (!isObj(c) || !Array.isArray(c.timedtexttracks)) continue;
    const tracks = c.timedtexttracks
      .slice(0, MAX_TRACKS)
      .map(readTrack)
      .filter((t): t is NetflixTrack => t !== null);
    if (tracks.length === 0) continue;
    return { movieId: str(c.movieId) || str(c.viewableId) || null, tracks };
  }
  return null;
}

/** Validates a manifest that crossed from the page world (anything there can be forged). */
export function isNetflixManifest(value: unknown): value is NetflixManifest {
  if (!isObj(value) || !Array.isArray(value.tracks) || value.tracks.length > MAX_TRACKS) return false;
  if (value.movieId !== null && typeof value.movieId !== 'string') return false;
  return value.tracks.every(
    (t) =>
      isObj(t) &&
      typeof t.id === 'string' && t.id.length <= 200 &&
      typeof t.language === 'string' && t.language.length <= 40 &&
      typeof t.label === 'string' && t.label.length <= 200 &&
      typeof t.kind === 'string' && t.kind.length <= 40 &&
      typeof t.forced === 'boolean' &&
      typeof t.imageOnly === 'boolean' &&
      Array.isArray(t.files) && t.files.length <= 40 &&
      t.files.every((f) => isObj(f) && typeof f.profile === 'string' && f.profile.length <= 60 && typeof f.url === 'string' && f.url.length <= MAX_URL),
  );
}

// Parsers for the subtitle formats the YouTube player downloads. Pure functions, unit-tested.
import type { Cue } from '../../shared/types';
import { isNonSpeech, normalizeCueText } from '../../shared/text.ts';

interface Json3Event {
  tStartMs?: number;
  dDurationMs?: number;
  segs?: { utf8?: string }[];
}

export interface TimedTextInfo {
  videoId: string | null;
  /** Language of the text: the translation target if the track is machine-translated. */
  language: string;
  kind: 'asr' | 'manual';
  translated: boolean;
}

/** Extracts track identity from a /api/timedtext URL. */
export function parseTimedTextUrl(url: string): TimedTextInfo | null {
  try {
    const params = new URL(url).searchParams;
    const lang = params.get('lang');
    if (!lang) return null;
    const tlang = params.get('tlang');
    return {
      videoId: params.get('v'),
      language: tlang || lang,
      kind: params.get('kind') === 'asr' ? 'asr' : 'manual',
      translated: Boolean(tlang),
    };
  } catch {
    return null;
  }
}

function finish(raw: { start: number; end: number; text: string }[]): Cue[] {
  const sorted = raw
    .map((c) => ({ ...c, text: normalizeCueText(c.text) }))
    .filter((c) => c.text.length > 0 && Number.isFinite(c.start) && c.end > c.start)
    .sort((a, b) => a.start - b.start);
  const cues: Cue[] = [];
  for (const cue of sorted) {
    const prev = cues[cues.length - 1];
    // Automatic captions repeat the previous line in a rolling window; keep each line once.
    if (prev && prev.text === cue.text && cue.start - prev.end < 0.5) {
      prev.end = Math.max(prev.end, cue.end);
      continue;
    }
    // Rolling captions overlap in time; a line ends when the next one starts.
    if (prev && prev.end > cue.start) prev.end = cue.start;
    cues.push({ index: cues.length, start: cue.start, end: cue.end, text: cue.text });
  }
  return cues.filter((c) => c.end > c.start).map((c, index) => ({ ...c, index }));
}

/** Parses the `json3` format. Returns null when the body is not json3. */
export function parseJson3(body: string): Cue[] | null {
  let data: { events?: Json3Event[] };
  try {
    data = JSON.parse(body) as { events?: Json3Event[] };
  } catch {
    return null;
  }
  if (!data || !Array.isArray(data.events)) return null;
  const raw: { start: number; end: number; text: string }[] = [];
  for (const event of data.events) {
    if (!Array.isArray(event.segs) || typeof event.tStartMs !== 'number') continue;
    const text = event.segs.map((s) => s.utf8 ?? '').join('');
    if (text.trim().length === 0) continue; // "append newline" events of rolling captions
    const start = event.tStartMs / 1000;
    const duration = typeof event.dDurationMs === 'number' && event.dDurationMs > 0 ? event.dDurationMs / 1000 : 4;
    raw.push({ start, end: start + duration, text });
  }
  return finish(raw);
}

/** Parses the XML formats (`srv1`: <text start dur>, `srv3`: <p t d>). Returns null when not XML. */
export function parseTimedTextXml(body: string): Cue[] | null {
  if (!body.trimStart().startsWith('<') || typeof DOMParser === 'undefined') return null;
  const doc = new DOMParser().parseFromString(body, 'text/xml');
  if (doc.querySelector('parsererror')) return null;
  const raw: { start: number; end: number; text: string }[] = [];
  for (const p of Array.from(doc.querySelectorAll('p'))) {
    const t = Number(p.getAttribute('t'));
    const d = Number(p.getAttribute('d'));
    const text = p.textContent ?? '';
    if (!Number.isFinite(t) || text.trim().length === 0) continue;
    raw.push({ start: t / 1000, end: (t + (Number.isFinite(d) && d > 0 ? d : 4000)) / 1000, text });
  }
  for (const node of Array.from(doc.querySelectorAll('text'))) {
    const start = Number(node.getAttribute('start'));
    const dur = Number(node.getAttribute('dur'));
    const text = node.textContent ?? '';
    if (!Number.isFinite(start) || text.trim().length === 0) continue;
    raw.push({ start, end: start + (Number.isFinite(dur) && dur > 0 ? dur : 4), text });
  }
  return finish(raw);
}

/** Parses whatever the player downloaded; empty array when the format is unknown. */
export function parseTimedText(body: string): Cue[] {
  return parseJson3(body) ?? parseTimedTextXml(body) ?? [];
}

/** Share of cues that carry speech; used to ignore tracks that only describe sounds. */
export function speechShare(cues: readonly Cue[]): number {
  if (cues.length === 0) return 0;
  return cues.filter((c) => !isNonSpeech(c.text)).length / cues.length;
}

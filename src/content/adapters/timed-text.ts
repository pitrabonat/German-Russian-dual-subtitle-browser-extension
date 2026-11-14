// Parsers for subtitle files that sites deliver next to the video: WebVTT and TTML/DFXP
// (Netflix serves both). Plain string processing, no DOM, so the same code runs in Node tests.
import type { Cue } from '../../shared/types';
import { normalizeCueText } from '../../shared/text.ts';

const MAX_CUES = 20_000;

/** "01:02:03.456", "02:03.456", "01:02:03,456" → seconds. */
function vttTime(value: string): number | null {
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/.exec(value.trim());
  if (!m) return null;
  return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]!.padEnd(3, '0')) / 1000;
}

export function parseWebVtt(body: string): Cue[] {
  const cues: Cue[] = [];
  const blocks = body.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split('\n');
    const at = lines.findIndex((l) => l.includes('-->'));
    if (at < 0) continue; // header, NOTE, STYLE, REGION
    const [from, rest] = lines[at]!.split('-->');
    const start = vttTime(from ?? '');
    const end = vttTime((rest ?? '').trim().split(/\s+/)[0] ?? '');
    if (start === null || end === null || !(end > start)) continue;
    const text = normalizeCueText(lines.slice(at + 1).join(' '));
    if (text.length === 0) continue;
    cues.push({ index: cues.length, start, end, text });
    if (cues.length >= MAX_CUES) break;
  }
  return sortAndIndex(cues);
}

function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`(?:^|\\s)(?:[\\w-]+:)?${name}\\s*=\\s*"([^"]*)"`, 'i').exec(tag);
  return m?.[1];
}

interface TtmlClock {
  tickRate: number;
  frameRate: number;
}

/** TTML time expressions: "123450000t", "12.5s", "500ms", "00:00:12.500", "00:00:12:15" (frames). */
function ttmlTime(value: string | undefined, clock: TtmlClock): number | null {
  if (!value) return null;
  const v = value.trim();
  let m = /^([\d.]+)(h|m|s|ms|f|t)$/.exec(v);
  if (m) {
    const n = Number(m[1]);
    switch (m[2]) {
      case 'h': return n * 3600;
      case 'm': return n * 60;
      case 's': return n;
      case 'ms': return n / 1000;
      case 'f': return n / clock.frameRate;
      case 't': return n / clock.tickRate;
    }
  }
  m = /^(\d+):(\d{2}):(\d{2})(?:\.(\d+)|:(\d+(?:\.\d+)?))?$/.exec(v);
  if (!m) return null;
  const base = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  if (m[4]) return base + Number(`0.${m[4]}`);
  if (m[5]) return base + Number(m[5]) / clock.frameRate;
  return base;
}

export function parseTtml(body: string): Cue[] {
  const root = /<tt\b[^>]*>/i.exec(body)?.[0] ?? '';
  const tickRate = Number(attr(root, 'tickRate')) || 10_000_000;
  const frameRate = (Number(attr(root, 'frameRate')) || 30) * (() => {
    const mul = attr(root, 'frameRateMultiplier')?.split(/\s+/).map(Number);
    return mul && mul.length === 2 && mul[0]! > 0 && mul[1]! > 0 ? mul[0]! / mul[1]! : 1;
  })();
  const clock: TtmlClock = { tickRate, frameRate };
  const cues: Cue[] = [];
  const paragraph = /<p\b([^>]*)>([\s\S]*?)<\/p>/gi;
  for (let m = paragraph.exec(body); m; m = paragraph.exec(body)) {
    const tag = m[1] ?? '';
    const start = ttmlTime(attr(tag, 'begin'), clock);
    let end = ttmlTime(attr(tag, 'end'), clock);
    const dur = ttmlTime(attr(tag, 'dur'), clock);
    if (end === null && start !== null && dur !== null) end = start + dur;
    if (start === null || end === null || !(end > start)) continue;
    const text = normalizeCueText((m[2] ?? '').replace(/<br\s*\/?>/gi, ' '));
    if (text.length === 0) continue;
    cues.push({ index: cues.length, start, end, text });
    if (cues.length >= MAX_CUES) break;
  }
  return sortAndIndex(cues);
}

/** Chooses the parser by content. Returns an empty list for anything else (image subtitles, HTML errors). */
export function parseSubtitleFile(body: string): Cue[] {
  const head = body.slice(0, 2000).replace(/^﻿/, '').trimStart();
  if (head.startsWith('WEBVTT')) return parseWebVtt(body);
  if (/<tt[\s>]/i.test(head) || /<\?xml/i.test(head)) return parseTtml(body);
  return [];
}

function sortAndIndex(cues: Cue[]): Cue[] {
  cues.sort((a, b) => a.start - b.start || a.end - b.end);
  return cues.map((c, i) => ({ ...c, index: i }));
}

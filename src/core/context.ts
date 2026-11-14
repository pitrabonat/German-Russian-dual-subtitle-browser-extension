// Context manager: groups subtitle cues into translation units and picks the dialogue
// that accompanies each unit as context.
//
// Why units instead of single cues: a German sentence is often spread over two or three cues,
// and its meaning may not be decidable from one of them ("Ich habe gestern meinen Freund," /
// "… in der Stadt getroffen."). Measured on the test set, translating the joined sentence scores
// 73.6 chrF against 55.9 for cue-by-cue translation (tests/results/translation). A unit is
// translated as a whole and its translation is shown under each of its cues, so every result
// still belongs to exact cue indexes and timestamps.
import type { Cue } from '../shared/types';
import { endsSentence, hasPunctuation, isNonSpeech, tokenize } from '../shared/text.ts';

export interface TranslationUnit {
  /** Position in the unit list. */
  index: number;
  /** Indexes of the cues that form this unit, in order. */
  cueIndexes: number[];
  /** Cue texts joined with single spaces. */
  text: string;
  start: number;
  end: number;
  /** For each cue of the unit: index of its first token within the unit's token list. */
  tokenOffsets: number[];
}

export interface UnitOptions {
  /** Join cues that belong to one sentence. */
  mergeFragments: boolean;
  /** Upper bounds that keep a unit readable and its translation quick. */
  maxCues?: number;
  maxChars?: number;
  /** Cues further apart than this (seconds) are never joined. */
  maxGap?: number;
}

const DEFAULTS = { maxCues: 4, maxChars: 260, maxGap: 1.6 } as const;

/** True when the track carries sentence punctuation; automatic captions usually do not. */
export function isPunctuated(cues: readonly Cue[]): boolean {
  const speech = cues.filter((c) => !isNonSpeech(c.text));
  if (speech.length === 0) return false;
  const withPunctuation = speech.filter((c) => hasPunctuation(c.text)).length;
  return withPunctuation / speech.length >= 0.25;
}

/** Splits a cue list into translation units. Cues without speech ("[Musik]") are left out. */
export function buildUnits(cues: readonly Cue[], options: UnitOptions): TranslationUnit[] {
  const maxCues = options.maxCues ?? DEFAULTS.maxCues;
  const maxChars = options.maxChars ?? DEFAULTS.maxChars;
  const maxGap = options.maxGap ?? DEFAULTS.maxGap;
  // Without punctuation there is no way to tell where a sentence ends, so nothing is joined.
  const merge = options.mergeFragments && isPunctuated(cues);

  const units: TranslationUnit[] = [];
  let i = 0;
  while (i < cues.length) {
    const first = cues[i]!;
    if (isNonSpeech(first.text)) {
      i++;
      continue;
    }
    const members: Cue[] = [first];
    let length = first.text.length;
    while (merge && members.length < maxCues) {
      const last = members[members.length - 1]!;
      const next = cues[i + members.length];
      if (!next || isNonSpeech(next.text)) break;
      if (endsSentence(last.text)) break;
      if (next.start - last.end > maxGap) break;
      if (length + 1 + next.text.length > maxChars) break;
      members.push(next);
      length += 1 + next.text.length;
    }

    const tokenOffsets: number[] = [];
    let offset = 0;
    for (const cue of members) {
      tokenOffsets.push(offset);
      offset += tokenize(cue.text).length;
    }
    units.push({
      index: units.length,
      cueIndexes: members.map((c) => c.index),
      text: members.map((c) => c.text).join(' '),
      start: first.start,
      end: members[members.length - 1]!.end,
      tokenOffsets,
    });
    i += members.length;
  }
  return units;
}

export interface UnitContext {
  before: string[];
  after: string[];
}

/**
 * Dialogue around a unit. Lines older than `maxAge` seconds are left out: after a pause the
 * conversation has usually moved on. At most one following unit is included, and only when it
 * starts soon, so translation never waits for dialogue that is far away.
 */
export function contextFor(units: readonly TranslationUnit[], index: number, contextSize: number, maxAge = 25): UnitContext {
  const unit = units[index];
  if (!unit || contextSize <= 0) return { before: [], after: [] };
  const before: string[] = [];
  for (let k = index - 1; k >= 0 && before.length < contextSize; k--) {
    const prev = units[k]!;
    if (unit.start - prev.end > maxAge) break;
    before.unshift(prev.text);
  }
  const next = units[index + 1];
  const after = next && next.start - unit.end <= 6 ? [next.text] : [];
  return { before, after };
}

/** Maps every cue index to the unit that contains it. */
export function indexUnitsByCue(units: readonly TranslationUnit[]): Map<number, TranslationUnit> {
  const map = new Map<number, TranslationUnit>();
  for (const unit of units) for (const cueIndex of unit.cueIndexes) map.set(cueIndex, unit);
  return map;
}

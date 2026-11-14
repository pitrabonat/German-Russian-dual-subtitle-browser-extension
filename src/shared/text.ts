// Text helpers shared by the content script and the background worker.
import type { Token } from './types';

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
};

/** Converts raw subtitle markup to plain single-line text. */
export function normalizeCueText(raw: string): string {
  return raw
    .replace(/<[^>]*>/g, '')
    .replace(/\{\\[^}]*\}/g, '') // ASS override blocks such as {\an8}
    .replace(/&(?:amp|lt|gt|quot|#39|apos|nbsp);/g, (m) => ENTITIES[m] ?? m)
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/[​‎‏﻿]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** True for cues without speech, such as "[Musik]" or "♪ ♪". */
export function isNonSpeech(text: string): boolean {
  const stripped = text.replace(/[[(（][^\])）]*[\])）]/g, '').replace(/[♪♫\-–—\s*#]/g, '');
  return stripped.length === 0;
}

/** True when the text ends like a finished sentence. */
export function endsSentence(text: string): boolean {
  return /[.!?…]["'»“”’)\]]*$/.test(text.trimEnd());
}

/** True when the text contains any sentence punctuation; automatic captions usually have none. */
export function hasPunctuation(text: string): boolean {
  return /[.!?,;:…]/.test(text);
}

/**
 * 53-bit string hash (cyrb53), returned in base 36. Fast, synchronous, and wide enough
 * for cache keys: with 100 000 entries the collision probability is below 1e-6.
 */
export function hashString(input: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

// A word starts with a letter and may continue with letters, digits, and inner hyphens or
// apostrophes ("E-Mail", "geht's"). A trailing apostrophe marks an elided ending ("hab'").
const TOKEN_RE = /(\p{L}[\p{L}\p{M}\d]*(?:[-'’][\p{L}\d]+)*['’]?)|(\d+(?:[.,:]\d+)*)|(\S)/gu;
const CLITIC_S_RE = /^(.{2,})(['’]s)$/i;

/** Splits German text into word, number and punctuation tokens. Whitespace is not a token. */
export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  const push = (value: string, start: number, kind: Token['kind']): void => {
    tokens.push({
      index: tokens.length,
      text: value,
      start,
      end: start + value.length,
      kind,
      spaceBefore: start > 0 && /\s/.test(text[start - 1] ?? ''),
    });
  };
  for (const m of text.matchAll(TOKEN_RE)) {
    const start = m.index ?? 0;
    if (m[1] !== undefined) {
      // "geht's" is two words: "geht" + "'s" (= es).
      const clitic = CLITIC_S_RE.exec(m[1]);
      if (clitic && clitic[1] !== undefined && clitic[2] !== undefined) {
        push(clitic[1], start, 'word');
        push(clitic[2], start + clitic[1].length, 'word');
      } else {
        push(m[1], start, 'word');
      }
    } else if (m[2] !== undefined) {
      push(m[2], start, 'number');
    } else if (m[3] !== undefined) {
      push(m[3], start, 'punct');
    }
  }
  return tokens;
}

export function capitalize(word: string): string {
  return word.length === 0 ? word : word[0]!.toLocaleUpperCase('de') + word.slice(1);
}

export function decapitalize(word: string): string {
  return word.length === 0 ? word : word[0]!.toLocaleLowerCase('de') + word.slice(1);
}

export function isCapitalized(word: string): boolean {
  const first = word[0];
  return first !== undefined && first !== first.toLocaleLowerCase('de') && first === first.toLocaleUpperCase('de');
}

export function isAllCaps(word: string): boolean {
  return word.length > 1 && word === word.toLocaleUpperCase('de') && word !== word.toLocaleLowerCase('de');
}

/** Clamps `value` into [min, max]. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

// Unit tests of the pure building blocks: text helpers, cue timeline, context manager,
// subtitle parsers, settings and message validation, prompts and sense selection.
import { describe, expect, it } from 'vitest';
import { PROMPT_VERSION, buildChatRequest, cleanModelOutput, looksRussian } from '../../src/background/translation/prompt.ts';
import { parseJson3, parseTimedText, parseTimedTextUrl, parseTimedTextXml } from '../../src/content/adapters/youtube-parse.ts';
import { looksGerman } from '../../src/content/adapters/types.ts';
import { buildUnits, contextFor, indexUnitsByCue, isPunctuated } from '../../src/core/context.ts';
import { Timeline } from '../../src/core/timeline.ts';
import { equivalents, pickSense, sameRussianWord } from '../../src/nlp/senses.ts';
import { isClientMessage, isContentRequest, isOffscreenRequest, isPageRequest, isRuntimeRequest } from '../../src/shared/messages.ts';
import { DEFAULT_SETTINGS, isLoopback, normalizeEndpoint, sanitizeSettings } from '../../src/shared/settings.ts';
import { endsSentence, hashString, isNonSpeech, normalizeCueText, tokenize } from '../../src/shared/text.ts';
import type { Cue } from '../../src/shared/types';

const cue = (index: number, start: number, end: number, text: string): Cue => ({ index, start, end, text });

describe('text helpers', () => {
  it('turns subtitle markup into plain single-line text', () => {
    expect(normalizeCueText('<i>Kannst du</i>\n mir   helfen?')).toBe('Kannst du mir helfen?');
    expect(normalizeCueText('Tom &amp; Jerry &#39;quoted&#39; &lt;3')).toBe("Tom & Jerry 'quoted' <3");
    expect(normalizeCueText('{\\an8}Oben <v Anna>Hallo</v>')).toBe('Oben Hallo');
  });

  it('recognises cues without speech', () => {
    expect(isNonSpeech('[Musik]')).toBe(true);
    expect(isNonSpeech('♪ ♪')).toBe(true);
    expect(isNonSpeech('(lacht) Na gut.')).toBe(false);
  });

  it('detects sentence ends, also before closing quotes', () => {
    expect(endsSentence('Das war es.')).toBe(true);
    expect(endsSentence('„Wirklich?“')).toBe(true);
    expect(endsSentence('Ich habe gestern meinen Freund,')).toBe(false);
  });

  it('tokenises German text into words, numbers and punctuation', () => {
    const tokens = tokenize("Wie geht's? Die E-Mail kam um 12:30, 3,5 Stunden später.");
    expect(tokens.map((t) => t.text)).toEqual(['Wie', 'geht', "'s", '?', 'Die', 'E-Mail', 'kam', 'um', '12:30', ',', '3,5', 'Stunden', 'später', '.']);
    expect(tokens.find((t) => t.text === '12:30')?.kind).toBe('number');
    expect(tokens.find((t) => t.text === "'s")).toMatchObject({ kind: 'word', spaceBefore: false });
    expect(tokens.find((t) => t.text === 'Die')?.spaceBefore).toBe(true);
    // Offsets point back into the source string.
    const text = 'Ich hab’ keine Zeit.';
    for (const t of tokenize(text)) expect(text.slice(t.start, t.end)).toBe(t.text);
  });

  it('hashes deterministically and separates similar strings', () => {
    expect(hashString('Guten Morgen')).toBe(hashString('Guten Morgen'));
    expect(hashString('Guten Morgen')).not.toBe(hashString('Guten Morgen.'));
    expect(hashString('a', 1)).not.toBe(hashString('a', 2));
  });
});

describe('timeline', () => {
  const timeline = new Timeline([cue(0, 1, 4, 'eins'), cue(1, 4.5, 7.5, 'zwei'), cue(2, 7, 9, 'drei (überlappt)')]);

  it('finds the cue on screen', () => {
    expect(timeline.at(0.5)).toBeNull();
    expect(timeline.at(1)?.text).toBe('eins');
    expect(timeline.at(4.2)).toBeNull();
    expect(timeline.at(5)?.text).toBe('zwei');
    expect(timeline.at(20)).toBeNull();
  });

  it('prefers the later cue when two overlap', () => {
    expect(timeline.at(7.2)?.text).toBe('drei (überlappt)');
  });

  it('reports the next boundary and the next cue index', () => {
    expect(timeline.nextBoundary(0)).toBe(1);
    expect(timeline.nextBoundary(2)).toBe(4);
    expect(timeline.nextBoundary(4.1)).toBe(4.5);
    expect(timeline.nextBoundary(9.5)).toBeNull();
    expect(timeline.indexFrom(0)).toBe(0);
    expect(timeline.indexFrom(4.2)).toBe(1);
    expect(timeline.indexFrom(100)).toBe(3);
  });
});

describe('context manager', () => {
  const cues = [
    cue(0, 1, 3, 'Ich habe gestern Abend meinen alten Freund,'),
    cue(1, 3, 6, 'den ich lange nicht gesehen hatte, getroffen.'),
    cue(2, 7, 9, 'Wie geht es dir?'),
    cue(3, 9.5, 11, '[Musik]'),
    cue(4, 20, 22, 'Wir haben den ganzen Tag'),
    cue(5, 40, 42, 'auf dich gewartet.'),
  ];

  it('joins cues that belong to one sentence and keeps their indexes', () => {
    const units = buildUnits(cues, { mergeFragments: true });
    expect(units.map((u) => u.cueIndexes)).toEqual([[0, 1], [2], [4], [5]]);
    expect(units[0]!.text).toBe('Ich habe gestern Abend meinen alten Freund, den ich lange nicht gesehen hatte, getroffen.');
    expect(units[0]!.start).toBe(1);
    expect(units[0]!.end).toBe(6);
    // Second cue starts after the 8 tokens of the first one (7 words and a comma).
    expect(units[0]!.tokenOffsets).toEqual([0, 8]);
  });

  it('does not join across a long pause, and leaves sound descriptions out', () => {
    const units = buildUnits(cues, { mergeFragments: true });
    expect(units.some((u) => u.cueIndexes.includes(3))).toBe(false);
    expect(units.find((u) => u.cueIndexes[0] === 4)!.cueIndexes).toEqual([4]);
  });

  it('keeps every cue separate when merging is off or the track has no punctuation', () => {
    expect(buildUnits(cues, { mergeFragments: false }).map((u) => u.cueIndexes.length)).toEqual([1, 1, 1, 1, 1]);
    const asr = [cue(0, 0, 2, 'ich stehe jeden morgen'), cue(1, 2, 4, 'um sieben uhr auf'), cue(2, 4, 6, 'und dann rufe ich')];
    expect(isPunctuated(asr)).toBe(false);
    expect(buildUnits(asr, { mergeFragments: true })).toHaveLength(3);
  });

  it('respects the size limits of a unit', () => {
    const many = Array.from({ length: 10 }, (_, i) => cue(i, i, i + 1, `Teil ${i},`));
    expect(buildUnits(many, { mergeFragments: true, maxCues: 3 }).map((u) => u.cueIndexes.length)).toEqual([3, 3, 3, 1]);
  });

  it('gives recent dialogue as context and at most one following line', () => {
    const units = buildUnits(cues, { mergeFragments: true });
    expect(contextFor(units, 1, 2)).toEqual({ before: [units[0]!.text], after: [] });
    expect(contextFor(units, 0, 2).after).toEqual(['Wie geht es dir?']);
    // Unit 2 starts 11 s after the previous one ended, unit 3 another 18 s later: too old.
    expect(contextFor(units, 3, 3, 15).before).toEqual([]);
    expect(contextFor(units, 1, 0)).toEqual({ before: [], after: [] });
    expect(indexUnitsByCue(units).get(1)).toBe(units[0]);
  });
});

describe('YouTube subtitle formats', () => {
  it('reads track identity from the request URL', () => {
    expect(parseTimedTextUrl('https://www.youtube.com/api/timedtext?v=abc&lang=de&fmt=json3')).toEqual({ videoId: 'abc', language: 'de', kind: 'manual', translated: false });
    expect(parseTimedTextUrl('https://www.youtube.com/api/timedtext?v=abc&lang=en&kind=asr&tlang=de')).toMatchObject({ language: 'de', kind: 'asr', translated: true });
    expect(parseTimedTextUrl('https://www.youtube.com/api/timedtext?v=abc')).toBeNull();
    expect(parseTimedTextUrl('not a url')).toBeNull();
  });

  it('parses manual json3 tracks', () => {
    const body = JSON.stringify({ events: [{ tStartMs: 1000, dDurationMs: 3000, segs: [{ utf8: 'Guten ' }, { utf8: 'Morgen!' }] }, { tStartMs: 5000, dDurationMs: 2000, segs: [{ utf8: 'Zweite\nZeile' }] }] });
    expect(parseJson3(body)).toEqual([
      { index: 0, start: 1, end: 4, text: 'Guten Morgen!' },
      { index: 1, start: 5, end: 7, text: 'Zweite Zeile' },
    ]);
  });

  it('turns rolling automatic captions into separate, non-overlapping lines', () => {
    const body = JSON.stringify({
      events: [
        { tStartMs: 0, dDurationMs: 100000, id: 1 },
        { tStartMs: 1000, dDurationMs: 5000, wWinId: 1, segs: [{ utf8: 'ich' }, { utf8: ' stehe', tOffsetMs: 300 }] },
        { tStartMs: 2990, dDurationMs: 2500, wWinId: 1, aAppend: 1, segs: [{ utf8: '\n' }] },
        { tStartMs: 3000, dDurationMs: 5000, wWinId: 1, segs: [{ utf8: 'jeden' }, { utf8: ' morgen', tOffsetMs: 400 }] },
      ],
    });
    const cues = parseJson3(body)!;
    expect(cues.map((c) => c.text)).toEqual(['ich stehe', 'jeden morgen']);
    expect(cues[0]!.end).toBe(3); // cut where the next line starts
    expect(cues[1]!.start).toBe(3);
  });

  it('returns nothing for empty or foreign bodies', () => {
    expect(parseTimedText('')).toEqual([]);
    expect(parseTimedText('<html>not subtitles</html>')).toEqual([]);
    expect(parseJson3('{"foo": 1}')).toBeNull();
    expect(parseTimedTextXml('{"events": []}')).toBeNull();
  });

  it('recognises German tracks by tag or label', () => {
    expect(looksGerman('de', '')).toBe(true);
    expect(looksGerman('de-AT', '')).toBe(true);
    expect(looksGerman('', 'Deutsch (automatisch)')).toBe(true);
    expect(looksGerman('nl', 'Nederlands')).toBe(false);
    expect(looksGerman('en', 'German lessons')).toBe(false);
  });
});

describe('settings', () => {
  it('falls back to defaults for missing or broken values', () => {
    expect(sanitizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(sanitizeSettings('nonsense')).toEqual(DEFAULT_SETTINGS);
    const s = sanitizeSettings({ enabled: 'yes', mode: 'cloud', contextSize: 99, appearance: { fontScale: -5, deColor: 'red', bgOpacity: 3 } });
    expect(s.enabled).toBe(true);
    expect(s.mode).toBe('browser');
    expect(s.contextSize).toBe(6);
    expect(s.appearance.fontScale).toBe(1.8);
    expect(s.appearance.deColor).toBe('#ffffff');
    expect(s.appearance.bgOpacity).toBe(1);
  });

  it('keeps valid values', () => {
    const s = sanitizeSettings({ mode: 'local', localProvider: 'ollama', ollamaModel: 'qwen3:4b-instruct', preloadAhead: 20, appearance: { ruColor: '#AABBCC', position: 30 } });
    expect(s).toMatchObject({ mode: 'local', localProvider: 'ollama', ollamaModel: 'qwen3:4b-instruct', preloadAhead: 20 });
    expect(s.appearance).toMatchObject({ ruColor: '#aabbcc', position: 30 });
  });

  it('normalises endpoints and rejects anything that is not a plain http(s) origin', () => {
    expect(normalizeEndpoint(' http://localhost:11434/api/chat ', 'x')).toBe('http://localhost:11434');
    expect(normalizeEndpoint('javascript:alert(1)', 'fallback')).toBe('fallback');
    expect(normalizeEndpoint('http://user:pw@127.0.0.1:1', 'fallback')).toBe('fallback');
    expect(normalizeEndpoint(42, 'fallback')).toBe('fallback');
    expect(isLoopback('http://127.0.0.1:8765')).toBe(true);
    expect(isLoopback('http://localhost:11434')).toBe(true);
    expect(isLoopback('http://192.168.1.5:11434')).toBe(false);
    expect(isLoopback('http://127.0.0.1.evil.example')).toBe(false);
  });
});

describe('message validation', () => {
  const item = { key: '1:2', text: 'Hallo', before: [], after: [], priority: 0 };

  it('accepts well-formed client messages', () => {
    expect(isClientMessage({ t: 'translate', items: [item] })).toBe(true);
    expect(isClientMessage({ t: 'cancel', keep: ['1:2'] })).toBe(true);
    expect(isClientMessage({ t: 'analyze', id: 1, sentence: 'Hallo Welt' })).toBe(true);
    expect(isClientMessage({ t: 'word-context', id: 1, sentence: 'Hallo Welt', tokenIndex: 0 })).toBe(true);
  });

  it('rejects malformed, oversized or unknown messages', () => {
    expect(isClientMessage(null)).toBe(false);
    expect(isClientMessage({ t: 'translate', items: [{ ...item, priority: 5 }] })).toBe(false);
    expect(isClientMessage({ t: 'translate', items: [{ ...item, text: '' }] })).toBe(false);
    expect(isClientMessage({ t: 'translate', items: [{ ...item, text: 'x'.repeat(5000) }] })).toBe(false);
    expect(isClientMessage({ t: 'translate', items: Array.from({ length: 100 }, () => item) })).toBe(false);
    expect(isClientMessage({ t: 'analyze', id: 'one', sentence: 'x' })).toBe(false);
    expect(isClientMessage({ t: 'word-context', id: 1, sentence: 'x', tokenIndex: -1 })).toBe(false);
    expect(isClientMessage({ t: 'eval', code: 'alert(1)' })).toBe(false);
  });

  it('validates popup, page and offscreen requests', () => {
    expect(isRuntimeRequest({ t: 'diagnostics' })).toBe(true);
    expect(isRuntimeRequest({ t: 'check-provider', provider: 'ollama' })).toBe(true);
    expect(isRuntimeRequest({ t: 'check-provider', provider: 'cloud' })).toBe(false);
    // Sites are no longer registered one by one: the content script runs everywhere.
    expect(isRuntimeRequest({ t: 'register-site', origin: 'https://example.org' })).toBe(false);
    expect(isContentRequest({ t: 'fetch-subtitles', url: 'https://ipv4-c001.oca.nflxvideo.net/?o=1&v=5' })).toBe(true);
    expect(isContentRequest({ t: 'fetch-subtitles', url: 'file:///c:/secret.txt' })).toBe(false);
    expect(isContentRequest({ t: 'fetch-subtitles', url: `https://a.nflxvideo.net/${'x'.repeat(5000)}` })).toBe(false);
    expect(isPageRequest({ t: 'page-state' })).toBe(true);
    expect(isPageRequest({ t: 'select-track', id: 5 })).toBe(false);
    expect(isOffscreenRequest({ target: 'offscreen', t: 'mt-translate', id: 1, texts: ['a'] })).toBe(true);
    expect(isOffscreenRequest({ target: 'background', t: 'mt-translate', id: 1, texts: ['a'] })).toBe(false);
  });
});

describe('LLM prompt helpers', () => {
  it('builds a chat request with context and a bounded answer length', () => {
    const request = buildChatRequest('qwen3:4b-instruct', { text: 'Sie ruft ihre Mutter', before: ['Was macht Anna?'], after: ['jeden Sonntag an.'] });
    expect(request.model).toBe('qwen3:4b-instruct');
    expect(request.stream).toBe(false);
    expect(request.think).toBe(false);
    expect(request.options.temperature).toBe(0);
    expect(request.options.num_predict).toBeLessThanOrEqual(320);
    const user = request.messages.at(-1)!.content;
    expect(user).toContain('Контекст до:\nWas macht Anna?');
    expect(user).toContain('Контекст после:\njeden Sonntag an.');
    expect(user.endsWith('Sie ruft ihre Mutter')).toBe(true);
    expect(buildChatRequest('m', { text: 'x', before: [], after: [] }, false).think).toBeUndefined();
    expect(PROMPT_VERSION).toBeGreaterThan(0);
  });

  it('cleans model output', () => {
    expect(cleanModelOutput('<think>hmm, Bahnhof…</think>\nЯ ничего не понимаю.')).toBe('Я ничего не понимаю.');
    expect(cleanModelOutput('Перевод: «Привет»')).toBe('Привет');
    expect(cleanModelOutput('Он встаёт в шесть.\n\n(Пояснение: aufstehen — отделяемый глагол.)')).toBe('Он встаёт в шесть.');
    expect(cleanModelOutput('<think>no closing tag')).toBe('');
  });

  it('tells Russian text from an echo of the German input', () => {
    expect(looksRussian('Я встаю в семь.')).toBe(true);
    expect(looksRussian('Ich stehe um sieben auf.')).toBe(false);
    expect(looksRussian('1945')).toBe(true);
    expect(looksRussian('')).toBe(false);
  });
});

describe('sense selection', () => {
  it('matches Russian word forms loosely', () => {
    expect(sameRussianWord('вставать', 'встаю')).toBe(true);
    expect(sameRussianWord('стол', 'столе')).toBe(true);
    expect(sameRussianWord('стоять', 'стол')).toBe(false);
    expect(sameRussianWord('дом', 'дома')).toBe(true);
  });

  it('splits a sense into its equivalents', () => {
    expect(equivalents('стол (предмет мебели); обед, трапеза')).toEqual(['стол', 'обед', 'трапеза']);
    expect(equivalents('разг. члены семьи')).toEqual(['члены семьи']);
  });

  it('prefers the sense that occurs in the sentence translation', () => {
    const senses = ['замок (запор)', 'замок, дворец'];
    const picked = pickSense(['скамья, скамейка', 'банк'], 'Банк сегодня закрыт.');
    expect(picked.contextual).toMatchObject({ value: 'банк', certainty: 'likely', source: 'dictionary' });
    expect(pickSense(senses, undefined).contextual).toMatchObject({ value: 'замок', certainty: 'uncertain' });
    expect(pickSense(['стол'], undefined).contextual).toMatchObject({ value: 'стол', certainty: 'likely' });
    expect(pickSense(['стол'], undefined, true).contextual).toMatchObject({ certainty: 'uncertain', source: 'mt' });
    expect(pickSense([], 'что-то')).toEqual({ senses: [] });
  });
});

// Unit tests of the parts that make the extension work beyond YouTube: subtitle file parsers,
// the Netflix manifest reader, the on-screen language check and the subtitle download guard.
import { describe, expect, it } from 'vitest';
import { fetchSubtitles, subtitleUrlAllowed } from '../../src/background/subtitle-fetch.ts';
import { LanguageGate, germanScore } from '../../src/content/adapters/dom-captions.ts';
import { parseSubtitleFile, parseTtml, parseWebVtt } from '../../src/content/adapters/timed-text.ts';
import { extractNetflixManifest, isNetflixManifest } from '../../src/inject/netflix-manifest.ts';
import { normalizeCueText } from '../../src/shared/text.ts';

describe('WebVTT', () => {
  it('reads cues with and without hours, settings and markup', () => {
    const cues = parseWebVtt(
      '﻿WEBVTT\n\nNOTE comment\n\n1\n00:00:01.000 --> 00:00:03.500 line:85%\n<c.yellow>Ich stehe</c> jeden\nMorgen auf.\n\n' +
        '01:02.250 --> 01:04.000\nGuten Tag!\n\n00:00:05,000 --> 00:00:04,000\nbroken\n',
    );
    expect(cues).toEqual([
      { index: 0, start: 1, end: 3.5, text: 'Ich stehe jeden Morgen auf.' },
      { index: 1, start: 62.25, end: 64, text: 'Guten Tag!' },
    ]);
  });

  it('handles CRLF files and sorts by start time', () => {
    const cues = parseWebVtt('WEBVTT\r\n\r\n00:00:09.000 --> 00:00:10.000\r\nB\r\n\r\n00:00:02.000 --> 00:00:03.000\r\nA\r\n');
    expect(cues.map((c) => [c.index, c.text])).toEqual([[0, 'A'], [1, 'B']]);
  });
});

describe('TTML / DFXP', () => {
  it('reads tick times with the declared tick rate', () => {
    const body =
      '<?xml version="1.0" encoding="utf-8"?><tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttp="http://www.w3.org/ns/ttml#parameter" ttp:tickRate="10000000">' +
      '<body><div><p begin="12345000t" end="40000000t" region="r1"><span style="s1">Wo ist</span><br/>der Bahnhof?</p>' +
      '<p begin="50000000t" end="60000000t">Da &amp; dort</p></div></body></tt>';
    const cues = parseTtml(body);
    expect(cues).toHaveLength(2);
    expect(cues[0]!.start).toBeCloseTo(1.2345, 6);
    expect(cues[0]!.end).toBe(4);
    expect(cues[0]!.text).toBe('Wo ist der Bahnhof?');
    expect(cues[1]!.text).toBe('Da & dort');
  });

  it('reads clock times, frames, offsets and dur', () => {
    const body =
      '<tt xmlns="http://www.w3.org/ns/ttml" ttp:frameRate="25" ttp:frameRateMultiplier="1000 1001"><body><div>' +
      '<p begin="00:00:01.500" end="00:00:02.750">eins</p>' +
      '<p begin="00:00:03:12" end="00:00:04:00">zwei</p>' +
      '<p begin="5s" dur="1500ms">drei</p>' +
      '<p begin="00:00:09.000">ohne Ende</p>' +
      '</div></body></tt>';
    const cues = parseTtml(body);
    expect(cues.map((c) => c.text)).toEqual(['eins', 'zwei', 'drei']);
    expect(cues[0]).toMatchObject({ start: 1.5, end: 2.75 });
    expect(cues[1]!.start).toBeCloseTo(3 + 12 / (25 * (1000 / 1001)), 6);
    expect(cues[2]).toMatchObject({ start: 5, end: 6.5 });
  });

  it('decodes numeric entities, decimal and hex', () => {
    expect(normalizeCueText('Gr&#252;&#x00DF;e &#99999999;')).toBe('Grüße &#99999999;');
  });

  it('picks the parser by content and refuses everything else', () => {
    expect(parseSubtitleFile('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHallo')).toHaveLength(1);
    expect(parseSubtitleFile('<tt><body><p begin="1s" end="2s">Hallo</p></body></tt>')).toHaveLength(1);
    expect(parseSubtitleFile('<!doctype html><html><body>403</body></html>')).toEqual([]);
    expect(parseSubtitleFile('\x89PNG...')).toEqual([]);
  });
});

/** A manifest in the shape the Netflix player receives (only the fields the reader looks at). */
function netflixManifest(): unknown {
  return {
    version: 2,
    result: {
      movieId: 81234567,
      timedtexttracks: [
        { isNoneTrack: true, language: 'none', rawTrackType: 'subtitles' },
        {
          language: 'de',
          languageDescription: 'Deutsch',
          rawTrackType: 'subtitles',
          isForcedNarrative: false,
          new_track_id: 'T:1:1;1;de;0;0;0;',
          ttDownloadables: {
            'imsc1.1': { urls: [{ cdn_id: 1, url: 'https://ipv4-c001.oca.nflxvideo.net/?o=1&v=imsc' }] },
            'webvtt-lssdh-ios8': { downloadUrls: { 10: 'https://ipv4-c001.oca.nflxvideo.net/?o=1&v=vtt', 11: 'https://ipv4-c002.oca.nflxvideo.net/?o=1&v=vtt' } },
          },
        },
        {
          language: 'de',
          languageDescription: 'Deutsch [Original]',
          rawTrackType: 'closedcaptions',
          new_track_id: 'T:1:1;1;de;1;0;0;',
          ttDownloadables: { 'dfxp-ls-sdh': { urls: [{ url: 'https://ipv4-c003.oca.nflxvideo.net/?o=1&v=dfxp' }] } },
        },
        {
          language: 'ja',
          languageDescription: 'Japanisch',
          rawTrackType: 'subtitles',
          new_track_id: 'T:1:1;1;ja;0;0;0;',
          ttDownloadables: { 'nflx-cmisc': { isImage: true, downloadUrls: { 1: 'https://ipv4-c004.oca.nflxvideo.net/?o=1&v=img' } } },
        },
      ],
    },
  };
}

describe('Netflix manifest', () => {
  it('lists text tracks with the best profile first and skips the "off" track', () => {
    const m = extractNetflixManifest(netflixManifest());
    expect(m?.movieId).toBe('81234567');
    expect(m?.tracks.map((t) => [t.language, t.kind, t.imageOnly])).toEqual([
      ['de', 'subtitles', false],
      ['de', 'closedcaptions', false],
      ['ja', 'subtitles', true],
    ]);
    const de = m!.tracks[0]!;
    expect(de.id).toBe('T:1:1;1;de;0;0;0;');
    expect(de.files.map((f) => f.profile)).toEqual(['webvtt-lssdh-ios8', 'webvtt-lssdh-ios8', 'imsc1.1']);
    expect(m!.tracks[2]!.files).toEqual([]);
    expect(isNetflixManifest(m)).toBe(true);
  });

  it('finds the manifest in result[0] as well, and ignores other JSON', () => {
    const wrapped = { result: [(netflixManifest() as { result: unknown }).result] };
    expect(extractNetflixManifest(wrapped)?.tracks).toHaveLength(3);
    expect(extractNetflixManifest({ result: { timedtexttracks: [] } })).toBeNull();
    expect(extractNetflixManifest([1, 2, 3])).toBeNull();
    expect(extractNetflixManifest('timedtexttracks')).toBeNull();
  });

  it('rejects forged or oversized manifests from the page', () => {
    const m = extractNetflixManifest(netflixManifest())!;
    expect(isNetflixManifest({ ...m, tracks: [{ ...m.tracks[0], files: 'x' }] })).toBe(false);
    expect(isNetflixManifest({ ...m, movieId: 5 })).toBe(false);
    expect(isNetflixManifest({ ...m, tracks: Array.from({ length: 201 }, () => m.tracks[0]) })).toBe(false);
    expect(isNetflixManifest({ ...m, tracks: [{ ...m.tracks[0], label: 'x'.repeat(201) }] })).toBe(false);
  });
});

describe('language of on-screen captions', () => {
  const feed = (gate: LanguageGate, lines: string[]) => lines.map((l) => gate.add(l)).at(-1);
  const GERMAN = ['Ich stehe jeden Morgen um sieben Uhr auf.', 'Die Kinder spielen draußen im Garten.', 'Kannst du mir bitte helfen?', 'Wir müssen jetzt gehen.'];
  const ENGLISH = [
    'The war was over and he put on his hat.',
    'I am going to the store, do you want anything?',
    'We should leave before it gets dark outside.',
    'She said that the meeting had been moved again.',
    'Nobody knows where the keys are right now.',
    'Can you believe what happened last night?',
  ];

  it('recognises German after a few lines', () => {
    expect(feed(new LanguageGate(), GERMAN.slice(0, 2))).toBe('german');
  });

  it('does not take Norwegian, Spanish, Finnish or English for German', () => {
    expect(feed(new LanguageGate(), ['Det er bra.', 'Hvor er du?', 'Jeg er her.', 'Ja, vi kommer nå.', 'Er du sikker på det?', 'Ja, det er jeg.'])).not.toBe('german');
    expect(feed(new LanguageGate(), ['Es muy bueno.', 'Es mi casa y es tu casa.', 'No es mal, es bien.'])).not.toBe('german');
    expect(feed(new LanguageGate(), ['Hän on tämä mies.', 'Tämä on hyvä päivä.', 'Mitä sinä teet täällä?'])).not.toBe('german');
    expect(feed(new LanguageGate(), ENGLISH)).toBe('other');
  });

  it('changes its mind when the viewer switches the subtitle language', () => {
    const gate = new LanguageGate();
    expect(feed(gate, ENGLISH)).toBe('other');
    expect(feed(gate, GERMAN)).toBe('german');
    expect(feed(gate, [...ENGLISH, ...ENGLISH])).toBe('other');
  });

  it('scores unambiguous words higher than shared ones', () => {
    expect(germanScore('Ich weiß es nicht').distinct).toBe(3); // ich, weiß, nicht; "es" is shared with Spanish
    expect(germanScore('er du ja es').distinct).toBe(0);
    expect(germanScore('').words).toBe(0);
  });
});

describe('subtitle download guard', () => {
  const NF = 'https://www.netflix.com/watch/81234567';

  it('lets Netflix pages fetch Netflix CDN files over https only', () => {
    expect(subtitleUrlAllowed('https://ipv4-c001.oca.nflxvideo.net/?o=1&v=5', NF)).toBe(true);
    expect(subtitleUrlAllowed('https://assets.nflxext.com/x.xml', NF)).toBe(true);
    expect(subtitleUrlAllowed('http://ipv4-c001.oca.nflxvideo.net/?o=1', NF)).toBe(false);
    expect(subtitleUrlAllowed('https://evil.example/nflxvideo.net', NF)).toBe(false);
    expect(subtitleUrlAllowed('https://nflxvideo.net.evil.example/', NF)).toBe(false);
    expect(subtitleUrlAllowed('https://user:pw@a.nflxvideo.net/', NF)).toBe(false);
    expect(subtitleUrlAllowed('http://127.0.0.1:11434/api/tags', NF)).toBe(false);
  });

  it('keeps other sites away from local services and from Netflix files', () => {
    expect(subtitleUrlAllowed('http://127.0.0.1:11434/api/tags', 'https://example.org/video')).toBe(false);
    expect(subtitleUrlAllowed('https://ipv4-c001.oca.nflxvideo.net/?o=1', 'https://netflix.com.evil.example/watch/1')).toBe(false);
    expect(subtitleUrlAllowed('http://127.0.0.1:8123/subs.vtt', 'http://127.0.0.1:8123/netflix-mock.html')).toBe(true);
    expect(subtitleUrlAllowed('https://example.org/subs.vtt', 'http://127.0.0.1:8123/netflix-mock.html')).toBe(false);
    expect(subtitleUrlAllowed('not a url', NF)).toBe(false);
    expect(subtitleUrlAllowed('https://a.nflxvideo.net/', undefined)).toBe(false);
  });

  it('downloads without cookies and reports failures in words', async () => {
    let seen: RequestInit | undefined;
    const ok = (async (_: unknown, init?: RequestInit) => {
      seen = init;
      return new Response('WEBVTT\n', { status: 200 });
    }) as typeof fetch;
    expect(await fetchSubtitles('https://a.nflxvideo.net/', ok)).toEqual({ ok: true, text: 'WEBVTT\n' });
    expect(seen).toMatchObject({ credentials: 'omit', redirect: 'error' });

    const missing = (async () => new Response('', { status: 403 })) as typeof fetch;
    const r1 = await fetchSubtitles('https://a.nflxvideo.net/', missing);
    expect(r1.ok === false && r1.error.message).toContain('403');

    const huge = (async () => new Response('', { status: 200, headers: { 'content-length': String(9 * 1024 * 1024) } })) as typeof fetch;
    const r2 = await fetchSubtitles('https://a.nflxvideo.net/', huge);
    expect(r2.ok === false && r2.error.message).toContain('8 МБ');

    const down = (async () => { throw new TypeError('Failed to fetch'); }) as typeof fetch;
    const r3 = await fetchSubtitles('https://a.nflxvideo.net/', down);
    expect(r3).toMatchObject({ ok: false, error: { code: 'unreachable' } });
  });
});

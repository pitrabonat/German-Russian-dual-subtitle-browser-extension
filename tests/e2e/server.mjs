// Tiny static server for the test pages. Also serves a generated silent WAV file, which gives
// the <video> element a real, seekable timeline without shipping a media file, and a mock of
// YouTube's subtitle endpoint for the mock player page.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const TYPES = { '.html': 'text/html; charset=utf-8', '.vtt': 'text/vtt; charset=utf-8', '.wav': 'audio/wav', '.js': 'text/javascript' };

function silentWav(seconds) {
  const rate = 8000;
  const samples = seconds * rate;
  const buf = Buffer.alloc(44 + samples, 128); // 8-bit PCM: 128 is silence
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + samples, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate, 28);
  buf.writeUInt16LE(1, 32);
  buf.writeUInt16LE(8, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(samples, 40);
  return buf;
}

const wav = silentWav(120);

// ── mock of YouTube's /api/timedtext ──

const VTT_CUE = /(\d\d):(\d\d):(\d\d)\.(\d{3}) --> (\d\d):(\d\d):(\d\d)\.(\d{3})\r?\n([\s\S]*?)(?:\r?\n\r?\n|$)/g;

export function parseVtt(text) {
  const cues = [];
  const ms = (h, m, s, f) => ((Number(h) * 60 + Number(m)) * 60 + Number(s)) * 1000 + Number(f);
  for (const m of text.matchAll(VTT_CUE)) cues.push({ start: ms(m[1], m[2], m[3], m[4]), end: ms(m[5], m[6], m[7], m[8]), text: m[9].trim() });
  return cues;
}

const plain = (text) => text.replace(/<[^>]+>/g, '');

/** Manual track: one event per cue. */
function json3Manual(cues) {
  return { wireMagic: 'pb3', events: cues.map((c) => ({ tStartMs: c.start, dDurationMs: c.end - c.start, segs: [{ utf8: plain(c.text) }] })) };
}

/** Automatic captions: lower-case words without punctuation in a two-line rolling window. */
function json3Asr(cues) {
  const events = [{ tStartMs: 0, dDurationMs: 120000, id: 1, wpWinPosId: 1, wsWinStyleId: 1 }];
  const lines = [];
  for (const c of cues) {
    const words = plain(c.text).replace(/[.,!?;:[\]]/g, '').toLowerCase().split(/\s+/).filter(Boolean);
    const per = (c.end - c.start) / Math.max(1, words.length);
    for (let i = 0; i < words.length; i += 5) lines.push({ start: Math.round(c.start + i * per), words: words.slice(i, i + 5), per });
  }
  lines.forEach((line, i) => {
    const next = lines[i + 1]?.start ?? line.start + 3000;
    events.push({
      tStartMs: line.start,
      dDurationMs: next - line.start + 2500,
      wWinId: 1,
      segs: line.words.map((w, k) => ({ utf8: (k ? ' ' : '') + w, ...(k ? { tOffsetMs: Math.round(k * line.per) } : {}), acAsrConf: 0 })),
    });
    events.push({ tStartMs: next - 10, dDurationMs: 2500, wWinId: 1, aAppend: 1, segs: [{ utf8: '\n' }] });
  });
  return { wireMagic: 'pb3', events };
}

async function timedText(query) {
  const video = query.get('v');
  if (video === 'empty') return '';
  let cues = parseVtt(await readFile(join(fixtures, query.get('lang') === 'en' ? 'en.vtt' : 'de.vtt'), 'utf8'));
  // The second video has its own first line, so that navigation can be told apart.
  if (video === 'video2') cues = cues.map((c, i) => (i === 0 ? { ...c, text: 'Willkommen zum zweiten Video.' } : c));
  return JSON.stringify(query.get('kind') === 'asr' ? json3Asr(cues) : json3Manual(cues));
}

// ── mock of the Netflix timed-text CDN: the German file as DFXP with tick times, like Netflix serves it ──

const escapeXml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function netflixDfxp() {
  const cues = parseVtt(await readFile(join(fixtures, 'de.vtt'), 'utf8'));
  const ticks = (ms) => `${ms * 10000}t`; // tickRate 10 000 000 per second
  const paragraphs = cues.map(
    (c, i) => `<p begin="${ticks(c.start)}" end="${ticks(c.end)}" region="region.${i % 2}"><span style="style_0">${escapeXml(plain(c.text)).replace(', ', ',<br/>')}</span></p>`,
  );
  return (
    '<?xml version="1.0" encoding="utf-8"?>\n<tt xmlns:tt="http://www.w3.org/ns/ttml" xmlns="http://www.w3.org/ns/ttml" ' +
    'xmlns:ttp="http://www.w3.org/ns/ttml#parameter" ttp:tickRate="10000000" xml:lang="de"><head><styling><style xml:id="style_0"/></styling></head>' +
    `<body><div>${paragraphs.join('\n')}</div></body></tt>`
  );
}

/** Starts the server on a free port of the loopback interface. */
export function startServer() {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      const path = normalize(decodeURIComponent(url.pathname)).replace(/^[\\/]+/, '').replace(/\\/g, '/');
      if (path === 'api/timedtext') {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(await timedText(url.searchParams));
        return;
      }
      if (path === 'nf/de.dfxp') {
        res.writeHead(200, { 'content-type': 'application/ttml+xml; charset=utf-8' });
        res.end(await netflixDfxp());
        return;
      }
      // Netflix player pages live at /watch/<title id>.
      const file = /^watch\/\d+$/.test(path) ? 'netflix-mock.html' : path;
      const body = file === 'silence.wav' ? wav : await readFile(join(fixtures, file || 'player.html'));
      const type = TYPES[extname(file)] ?? 'application/octet-stream';
      const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
      if (range) {
        const start = Number(range[1]);
        const end = range[2] ? Math.min(Number(range[2]), body.length - 1) : body.length - 1;
        res.writeHead(206, { 'content-type': type, 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${body.length}`, 'content-length': end - start + 1 });
        res.end(body.subarray(start, end + 1));
      } else {
        res.writeHead(200, { 'content-type': type, 'accept-ranges': 'bytes', 'content-length': body.length });
        res.end(body);
      }
    } catch {
      res.writeHead(404);
      res.end('not found');
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ origin: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

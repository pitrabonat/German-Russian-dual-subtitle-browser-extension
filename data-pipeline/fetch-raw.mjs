// Downloads the raw sources of the dictionary into data/raw (about 405 MB once gzip-compressed;
// the Wiktionary extracts are about 2.5 GB uncompressed, so they are compressed while saving).
//
//   node data-pipeline/fetch-raw.mjs          skip files that already exist
//   node data-pipeline/fetch-raw.mjs --force  download again
import { createWriteStream, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';

const raw = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'raw');
const force = process.argv.includes('--force');

const SOURCES = [
  // [file, url] — files ending in .gz are compressed locally
  ['enwikt-de.jsonl.gz', 'https://kaikki.org/dictionary/German/kaikki.org-dictionary-German.jsonl'],
  ['ruwikt-de.jsonl.gz', 'https://kaikki.org/ruwiktionary/%D0%9D%D0%B5%D0%BC%D0%B5%D1%86%D0%BA%D0%B8%D0%B9/kaikki.org-dictionary-%D0%9D%D0%B5%D0%BC%D0%B5%D1%86%D0%BA%D0%B8%D0%B9.jsonl'],
  ['dewikt-de.jsonl.gz', 'https://kaikki.org/dewiktionary/Deutsch/kaikki.org-dictionary-Deutsch.jsonl'],
  ['de_50k.txt', 'https://raw.githubusercontent.com/hermitdave/FrequencyWords/master/content/2018/de/de_50k.txt'],
];

mkdirSync(raw, { recursive: true });
for (const [file, url] of SOURCES) {
  const target = join(raw, file);
  if (existsSync(target) && !force) {
    console.log(`${file}: present, skipped`);
    continue;
  }
  const t0 = Date.now();
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`${file}: HTTP ${res.status}`);
  const part = `${target}.part`;
  const steps = [Readable.fromWeb(res.body)];
  if (file.endsWith('.gz')) steps.push(createGzip({ level: 6 }));
  await pipeline(...steps, createWriteStream(part));
  renameSync(part, target);
  console.log(`${file}: ${(statSync(target).size / 1e6).toFixed(1)} MB in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}

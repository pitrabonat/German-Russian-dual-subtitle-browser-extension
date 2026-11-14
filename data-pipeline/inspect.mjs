// Prints structure samples and statistics for the raw kaikki dumps.
// Usage: node data-pipeline/inspect.mjs <en|de|ru> [word ...]
import { createReadStream } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const which = process.argv[2] ?? 'ru';
const words = new Set(process.argv.slice(3).length ? process.argv.slice(3) : ['stehen', 'aufstehen', 'Tisch', 'gut', 'stehe', 'Tische', 'aufgestanden']);
const file = join(root, 'data', 'raw', `${which}wikt-de.jsonl.gz`);
const cut = (s, n = 90) => (s == null ? '' : String(s).length > n ? String(s).slice(0, n) + '…' : String(s));

const pos = new Map();
const formTags = new Map();
const topTags = new Map();
const keys = new Map();
let total = 0, withForms = 0, formCount = 0, withRu = 0, formOf = 0, withExamples = 0;
const bump = (m, k, by = 1) => m.set(k, (m.get(k) ?? 0) + by);
const samples = [];

const rl = createInterface({ input: createReadStream(file).pipe(createGunzip()), crlfDelay: Infinity });
for await (const line of rl) {
  if (!line) continue;
  const e = JSON.parse(line);
  total++;
  bump(pos, e.pos ?? '?');
  for (const k of Object.keys(e)) bump(keys, k);
  for (const t of e.tags ?? []) bump(topTags, t);
  if (e.forms?.length) {
    withForms++;
    formCount += e.forms.length;
    for (const f of e.forms) for (const t of f.tags ?? f.raw_tags ?? []) bump(formTags, t);
  }
  if (e.translations?.some((t) => (t.lang_code ?? t.code) === 'ru')) withRu++;
  if (e.senses?.some((s) => s.form_of?.length)) formOf++;
  if (e.senses?.some((s) => s.examples?.length)) withExamples++;
  if (words.has(e.word) && samples.length < 40) samples.push(e);
}

const top = (m, n) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${k}:${v}`).join(' ');
console.log(`## ${which}wikt: entries=${total} withForms=${withForms} forms=${formCount} withRuTranslations=${withRu} formOfEntries=${formOf} withExamples=${withExamples}`);
console.log('pos:', top(pos, 30));
console.log('keys:', top(keys, 40));
console.log('topTags:', top(topTags, 40));
console.log('formTags:', top(formTags, 90));
for (const e of samples) {
  console.log(`\n--- ${e.word} [${e.pos}] tags=${(e.tags ?? []).join(',')} keys=${Object.keys(e).join(',')}`);
  if (e.head_templates) console.log('  head:', cut(JSON.stringify(e.head_templates.map((h) => h.expansion)), 200));
  if (e.forms) console.log(`  forms(${e.forms.length}):`, cut(e.forms.slice(0, 28).map((f) => `${f.form}[${(f.tags ?? []).join(' ')}${f.raw_tags ? ' |' + f.raw_tags.join(' ') : ''}${f.source ? ' @' + f.source : ''}]`).join('; '), 1500));
  (e.senses ?? []).slice(0, 3).forEach((s, i) => {
    console.log(`  sense${i}: ${cut((s.glosses ?? s.raw_glosses ?? []).join(' | '), 160)} tags=${(s.tags ?? []).join(',')} raw=${(s.raw_tags ?? []).join(',')} idx=${s.sense_index ?? ''} form_of=${JSON.stringify(s.form_of ?? '')} keys=${Object.keys(s).join(',')}`);
    if (s.examples?.[0]) console.log('     ex:', cut(JSON.stringify(s.examples[0]), 260));
  });
  const ru = (e.translations ?? []).filter((t) => (t.lang_code ?? t.code) === 'ru');
  if (ru.length) console.log('  ru:', cut(ru.map((t) => `${t.word}{${t.sense_index ?? t.sense ?? ''}}${t.tags ? '[' + t.tags.join(' ') + ']' : ''}`).join('; '), 500));
  if (e.synonyms) console.log('  syn:', cut(e.synonyms.slice(0, 6).map((s) => `${s.word}{${s.sense_index ?? ''}}`).join('; '), 200));
  for (const k of ['hyphenation', 'hyphenations', 'categories', 'etymology_text', 'derived', 'related', 'antonyms']) if (e[k]) console.log(`  ${k}:`, cut(JSON.stringify(e[k]), 140));
}

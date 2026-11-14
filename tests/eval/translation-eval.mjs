// Scores translation outputs against the reference set and prints a comparison table.
//
//   node tests/eval/translation-eval.mjs                 all files in tests/results/translation/
//   node tests/eval/translation-eval.mjs --worst 12 ct2-int8-beam2   show the weakest sentences of one run
//   node tests/eval/translation-eval.mjs --show sp,id ct2-int8-beam2  print hypotheses of some categories
//
// Metric: chrF2 (character n-grams 1..6, beta = 2, whitespace ignored), the same definition as
// sacreBLEU's default chrF. Corpus scores pool n-gram statistics over all sentences.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const resultsDir = join(root, 'tests', 'results', 'translation');
const set = JSON.parse(readFileSync(join(root, 'tests', 'data', 'translation-set.json'), 'utf8')).items;
const byId = new Map(set.map((it) => [it.id, it]));

const ORDER = 6;
const BETA2 = 4;

function ngrams(text, n) {
  const s = text.replace(/\s+/g, '');
  const counts = new Map();
  for (let i = 0; i + n <= s.length; i++) {
    const g = s.slice(i, i + n);
    counts.set(g, (counts.get(g) ?? 0) + 1);
  }
  return counts;
}

/** Returns per-order [matches, hypothesisTotal, referenceTotal]. */
export function chrfStats(hyp, ref) {
  const stats = [];
  for (let n = 1; n <= ORDER; n++) {
    const h = ngrams(hyp, n);
    const r = ngrams(ref, n);
    let match = 0, hTotal = 0, rTotal = 0;
    for (const [g, c] of h) { hTotal += c; match += Math.min(c, r.get(g) ?? 0); }
    for (const c of r.values()) rTotal += c;
    stats.push([match, hTotal, rTotal]);
  }
  return stats;
}

export function chrfFromStats(stats) {
  let sum = 0, orders = 0;
  for (const [match, hTotal, rTotal] of stats) {
    if (hTotal === 0 || rTotal === 0) continue;
    const p = match / hTotal;
    const r = match / rTotal;
    sum += p + r === 0 ? 0 : ((1 + BETA2) * p * r) / (BETA2 * p + r);
    orders++;
  }
  return orders === 0 ? 0 : (100 * sum) / orders;
}

const addStats = (a, b) => a.map((row, i) => row.map((v, j) => v + b[i][j]));
const zero = () => Array.from({ length: ORDER }, () => [0, 0, 0]);
export const chrf = (hyp, ref) => chrfFromStats(chrfStats(hyp, ref));

function evaluate(run) {
  const perCat = new Map();
  let all = zero();
  const sentences = [];
  for (const out of run.items) {
    const ref = byId.get(out.id);
    if (!ref) continue;
    const st = chrfStats(out.hyp, ref.ru);
    all = addStats(all, st);
    perCat.set(ref.cat, addStats(perCat.get(ref.cat) ?? zero(), st));
    sentences.push({ id: out.id, cat: ref.cat, de: ref.de, ref: ref.ru, hyp: out.hyp, score: chrfFromStats(st), ms: out.ms });
  }
  // Fragment strategies are judged on the whole sentence: concatenated output against `ruFull`.
  const frag = {};
  for (const g of run.fragments ?? []) {
    const refFull = set.find((it) => it.group === g.group && it.ruFull)?.ruFull;
    if (!refFull) continue;
    for (const mode of ['isolated', 'merged', 'prefix']) {
      if (g[mode] === undefined) continue;
      const hyp = Array.isArray(g[mode]) ? g[mode].join(' ') : g[mode];
      frag[mode] = addStats(frag[mode] ?? zero(), chrfStats(hyp, refFull));
    }
  }
  return {
    chrf: chrfFromStats(all),
    cats: Object.fromEntries([...perCat].map(([k, v]) => [k, chrfFromStats(v)])),
    fragments: Object.fromEntries(Object.entries(frag).map(([k, v]) => [k, chrfFromStats(v)])),
    sentences,
  };
}

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const worst = flag('--worst');
const show = flag('--show');
const names = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--')));
const files = readdirSync(resultsDir).filter((f) => f.endsWith('.json') && f !== 'summary.json' && (names.length === 0 || names.includes(f.replace(/\.json$/, ''))));

const summary = [];
for (const f of files) {
  const run = JSON.parse(readFileSync(join(resultsDir, f), 'utf8'));
  const ev = evaluate(run);
  summary.push({ run: f.replace(/\.json$/, ''), provider: run.provider, runtime: run.runtime, chrf: ev.chrf, cats: ev.cats, fragments: ev.fragments, latency: run.latency, initMs: run.initMs, n: ev.sentences.length });
  if (worst) {
    console.log(`\n### weakest ${worst} of ${f}`);
    for (const s of [...ev.sentences].sort((a, b) => a.score - b.score).slice(0, Number(worst))) console.log(`${s.id} ${s.score.toFixed(0)} | ${s.de}\n     hyp: ${s.hyp}\n     ref: ${s.ref}`);
  }
  if (show) {
    const prefixes = show.split(',');
    console.log(`\n### ${f}`);
    for (const s of ev.sentences) if (prefixes.some((p) => s.id.startsWith(p))) console.log(`${s.id} ${s.score.toFixed(0)} | ${s.de} => ${s.hyp}`);
    for (const g of run.fragments ?? []) if (prefixes.includes('fr')) console.log(`${g.group}: isolated=[${g.isolated.join(' | ')}] merged=[${g.merged}] prefix=[${(g.prefix ?? []).join(' | ')}]`);
  }
}

const cats = [...new Set(set.map((it) => it.cat))];
const pad = (s, n) => String(s).padEnd(n);
console.log('\n' + pad('run', 26) + pad('chrF', 7) + cats.map((c) => pad(c.slice(0, 6), 8)).join('') + pad('avg ms', 8) + pad('med', 7) + pad('p95', 7) + 'init ms');
for (const s of summary) {
  console.log(pad(s.run, 26) + pad(s.chrf.toFixed(1), 7) + cats.map((c) => pad((s.cats[c] ?? 0).toFixed(1), 8)).join('') + pad(s.latency?.avg ?? '', 8) + pad(s.latency?.median ?? '', 7) + pad(s.latency?.p95 ?? '', 7) + (s.initMs ?? ''));
  if (Object.keys(s.fragments).length) console.log(pad('', 26) + 'fragments (whole-sentence chrF): ' + Object.entries(s.fragments).map(([k, v]) => `${k} ${v.toFixed(1)}`).join(', '));
}
writeFileSync(join(resultsDir, 'summary.json'), JSON.stringify(summary, null, 1));

// Translates the test set through the Mitlesen local service (the same HTTP calls the
// extension makes) and records per-sentence latency.
//
//   node tests/eval/run-service.mjs [--endpoint http://127.0.0.1:8765] [--out tests/results/translation/service-ct2.json]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const flag = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const endpoint = flag('--endpoint', 'http://127.0.0.1:8765');
const out = flag('--out', 'tests/results/translation/service-ct2.json');
const items = JSON.parse(readFileSync(join(root, 'tests', 'data', 'translation-set.json'), 'utf8')).items;

const health = await (await fetch(`${endpoint}/health`)).json();
if (!health.translate?.ready) throw new Error(`service not ready: ${JSON.stringify(health.translate)}`);

async function translate(texts) {
  const res = await fetch(`${endpoint}/translate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ texts }) });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return (await res.json()).translations;
}

await translate(['Guten Tag.']);
const outItems = [];
for (const it of items) {
  const t = performance.now();
  const [hyp] = await translate([it.de]);
  outItems.push({ id: it.id, hyp, ms: Math.round(performance.now() - t) });
}
const groups = new Map();
for (const it of items) if (it.group) groups.set(it.group, [...(groups.get(it.group) ?? []), it]);
const fragments = [];
for (const [gid, parts] of groups) {
  const [merged] = await translate([parts.map((p) => p.de).join(' ')]);
  fragments.push({ group: gid, de: parts.map((p) => p.de), isolated: parts.map((p) => outItems.find((o) => o.id === p.id).hyp), merged });
}
// Throughput of the batched path used for preloading.
const batchStart = performance.now();
for (let i = 0; i < 40; i += 4) await translate(items.slice(i, i + 4).map((it) => it.de));
const batchMsPerSentence = (performance.now() - batchStart) / 40;

const lat = outItems.map((o) => o.ms).sort((a, b) => a - b);
const summary = {
  provider: 'local-service',
  runtime: `Mitlesen service ${health.version}, ${health.translate.model}, ${health.translate.device}, beam 2, over HTTP`,
  latency: { avg: Math.round(lat.reduce((a, b) => a + b, 0) / lat.length), median: lat[Math.floor(lat.length / 2)], p95: lat[Math.ceil(lat.length * 0.95) - 1], max: lat.at(-1) },
  batchOf4MsPerSentence: Math.round(batchMsPerSentence),
};
const outPath = isAbsolute(out) ? out : join(root, out);
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify({ ...summary, items: outItems, fragments }, null, 1));
console.log(JSON.stringify(summary));

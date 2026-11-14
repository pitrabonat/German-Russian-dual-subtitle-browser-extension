// Translates the test set with the browser model files through transformers.js in Node
// (onnxruntime-node on the CPU). This checks the ONNX export, the int8 quantization and the
// JavaScript tokenizer against the CTranslate2 reference before the model goes into the browser.
//
//   node tests/eval/run-onnx-node.mjs [--limit 20] [--dtype q8] [--out tests/results/translation/onnx-q8-node.json]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { env, pipeline } from '@huggingface/transformers';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const flag = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const dtype = flag('--dtype', 'q8');
const limit = Number(flag('--limit', '0'));
const out = flag('--out', `tests/results/translation/onnx-${dtype}-node.json`);

env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = join(root, 'models', 'browser') + '/';

let items = JSON.parse(readFileSync(join(root, 'tests', 'data', 'translation-set.json'), 'utf8')).items;
if (limit) items = items.slice(0, limit);

const t0 = performance.now();
const translator = await pipeline('translation', 'opus-mt-tc-big-de-zle', { dtype });
const translate = async (text) => (await translator(`>>rus<< ${text}`, { max_new_tokens: 256, num_beams: 1, do_sample: false }))[0].translation_text;
console.log('warm-up:', await translate('Guten Tag.'));
const initMs = performance.now() - t0;

const outItems = [];
for (const it of items) {
  const t = performance.now();
  const hyp = await translate(it.de);
  outItems.push({ id: it.id, hyp, ms: Math.round(performance.now() - t) });
}
const groups = new Map();
for (const it of items) if (it.group) groups.set(it.group, [...(groups.get(it.group) ?? []), it]);
const fragments = [];
for (const [gid, parts] of groups) {
  fragments.push({ group: gid, de: parts.map((p) => p.de), isolated: parts.map((p) => outItems.find((o) => o.id === p.id).hyp), merged: await translate(parts.map((p) => p.de).join(' ')) });
}

const lat = outItems.map((o) => o.ms).sort((a, b) => a - b);
const summary = {
  provider: `onnx-${dtype}-node`,
  runtime: `transformers.js ${env.version}, onnxruntime-node (CPU), greedy decoding`,
  initMs: Math.round(initMs),
  latency: { avg: Math.round(lat.reduce((a, b) => a + b, 0) / lat.length), median: lat[Math.floor(lat.length / 2)], p95: lat[Math.ceil(lat.length * 0.95) - 1], max: lat.at(-1) },
};
const outPath = isAbsolute(out) ? out : join(root, out);
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify({ ...summary, items: outItems, fragments }, null, 1));
console.log(JSON.stringify(summary));

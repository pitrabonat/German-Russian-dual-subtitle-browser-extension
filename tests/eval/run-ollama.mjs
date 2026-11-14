// Translates the test set through a local Ollama server and records per-sentence latency.
//
//   node tests/eval/run-ollama.mjs --model qwen3:4b --out tests/results/translation/ollama-qwen3-4b.json
//   options: --endpoint http://127.0.0.1:11434   --no-context   --limit 20
//
// The prompt is imported from the extension source so that the benchmark measures exactly what
// the extension sends.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildChatRequest, cleanModelOutput } from '../../src/background/translation/prompt.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const flag = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const model = flag('--model', 'qwen3:4b');
const endpoint = flag('--endpoint', 'http://127.0.0.1:11434');
const useContext = !argv.includes('--no-context');
// Put every layer on the GPU instead of Ollama's automatic split (see MODEL_COMPARISON.md).
const fullGpu = argv.includes('--full-gpu');
const limit = Number(flag('--limit', '0'));
const out = flag('--out', `tests/results/translation/ollama-${model.replace(/[:/]/g, '-')}.json`);

let items = JSON.parse(readFileSync(join(root, 'tests', 'data', 'translation-set.json'), 'utf8')).items;
if (limit) items = items.slice(0, limit);

async function translate(text, before = [], after = []) {
  const body = buildChatRequest(model, { text, before: useContext ? before : [], after: useContext ? after : [] });
  if (fullGpu) body.options.num_gpu = 99;
  const t = performance.now();
  const res = await fetch(`${endpoint}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = await res.json();
  return {
    hyp: cleanModelOutput(json.message?.content ?? ''),
    ms: performance.now() - t,
    outTokens: json.eval_count ?? 0,
    evalMs: (json.eval_duration ?? 0) / 1e6,
    promptTokens: json.prompt_eval_count ?? 0,
    promptMs: (json.prompt_eval_duration ?? 0) / 1e6,
    loadMs: (json.load_duration ?? 0) / 1e6,
  };
}

const t0 = performance.now();
const warm = await translate('Guten Tag.');
const initMs = performance.now() - t0;
console.log(`warm-up: ${Math.round(initMs)} ms (model load ${Math.round(warm.loadMs)} ms) -> ${warm.hyp}`);

const outItems = [];
let outTokens = 0, evalMs = 0, promptTokens = 0, promptMs = 0;
for (const it of items) {
  const r = await translate(it.de, it.before, it.after);
  outItems.push({ id: it.id, hyp: r.hyp, ms: Math.round(r.ms) });
  outTokens += r.outTokens; evalMs += r.evalMs; promptTokens += r.promptTokens; promptMs += r.promptMs;
  if (outItems.length % 20 === 0) console.log(`${outItems.length}/${items.length}`);
}

// Fragments: "isolated" here means each line alone but with its neighbours given as context.
const groups = new Map();
for (const it of items) if (it.group) groups.set(it.group, [...(groups.get(it.group) ?? []), it]);
const fragments = [];
for (const [gid, parts] of groups) {
  const merged = await translate(parts.map((p) => p.de).join(' '));
  fragments.push({ group: gid, de: parts.map((p) => p.de), isolated: parts.map((p) => outItems.find((o) => o.id === p.id).hyp), merged: merged.hyp, mergedMs: Math.round(merged.ms) });
}

const lat = outItems.map((o) => o.ms).sort((a, b) => a - b);
const ps = await (await fetch(`${endpoint}/api/ps`)).json().catch(() => ({}));
const running = (ps.models ?? []).find((m) => m.name === model || m.model === model);
const summary = {
  provider: `ollama-${model}${useContext ? '' : '-noctx'}${fullGpu ? '-fullgpu' : ''}`,
  runtime: `Ollama ${(await (await fetch(`${endpoint}/api/version`)).json()).version}, ${running ? `VRAM ${(running.size_vram / 1048576).toFixed(0)} MB of ${(running.size / 1048576).toFixed(0)} MB` : 'unknown placement'}`,
  initMs: Math.round(initMs),
  latency: { avg: Math.round(lat.reduce((a, b) => a + b, 0) / lat.length), median: lat[Math.floor(lat.length / 2)], p95: lat[Math.ceil(lat.length * 0.95) - 1], max: lat.at(-1) },
  tokensPerSecond: { generation: +(outTokens / (evalMs / 1000)).toFixed(1), prompt: +(promptTokens / (promptMs / 1000)).toFixed(1) },
  avgTokens: { prompt: Math.round(promptTokens / items.length), output: +(outTokens / items.length).toFixed(1) },
};
const outPath = isAbsolute(out) ? out : join(root, out);
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify({ ...summary, items: outItems, fragments }, null, 1));
console.log(JSON.stringify(summary));

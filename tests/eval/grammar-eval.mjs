// Runs the grammar test cases through the analyser and reports accuracy per category.
//
//   node tests/eval/grammar-eval.mjs                 browser engine (dictionary + rules)
//   node tests/eval/grammar-eval.mjs --parser http://127.0.0.1:8765   with the spaCy parse of the local service
//   node tests/eval/grammar-eval.mjs --set heldout   the cases that were never used for tuning
//   node tests/eval/grammar-eval.mjs --fail          also list every failed check
//
// "wrongAndCertain" counts wrong values that the engine presented as certain. Wrong values
// that carry an uncertainty mark are honest mistakes.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ShardDictionary } from '../../src/nlp/dictionary.ts';
import { runGrammarCases } from './grammar-lib.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const parser = flag('--parser');
const set = flag('--set') ?? 'cases';

const dict = new ShardDictionary(async (path) => JSON.parse(readFileSync(join(root, 'data', 'dict', path), 'utf8')));
const { cases } = JSON.parse(readFileSync(join(root, 'tests', 'data', `grammar-${set}.json`), 'utf8'));

async function parse(sentence) {
  const res = await fetch(`${parser}/analyze`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: sentence }) });
  if (!res.ok) throw new Error(`parser HTTP ${res.status}`);
  return (await res.json()).tokens;
}

const result = await runGrammarCases({ dict, cases, parse: parser ? parse : undefined });
const { failures, ...summary } = result;
const engine = parser ? 'browser analyser + spaCy parse' : 'browser analyser (dictionary + rules)';
console.log(JSON.stringify({ engine, set, ...summary }, null, 1));
if (argv.includes('--fail')) console.log('\n' + failures.join('\n'));
const outDir = join(root, 'tests', 'results', 'grammar');
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, `${set}-${parser ? 'spacy' : 'browser'}.json`), JSON.stringify({ engine, set, ...summary, failures }, null, 1));

// Shared by the command-line evaluation and the unit tests: runs grammar cases through the
// analyser and compares the reported facts with the expected ones.
import { analyzeSentence } from '../../src/nlp/analyzer.ts';
import { tokenize } from '../../src/shared/text.ts';

const list = (m) => (m ? (Array.isArray(m.value) ? m.value.join('/') : m.value) : undefined);

// Each reader returns [actual value, certainty of that value or undefined for plain dictionary fields].
const READERS = {
  pos: (a) => [a.pos.value, a.pos.certainty],
  lemma: (a) => [a.kind === 'verb' ? a.infinitive : a.lemma.value, a.lemma.certainty],
  gender: (a) => [a.kind === 'noun' ? list(a.gender) : undefined, a.gender?.certainty],
  agender: (a) => [a.kind === 'adjective' ? list(a.gender) : undefined, a.gender?.certainty],
  plural: (a, want) => [a.plural?.value.includes(want) ? want : list(a.plural), a.plural?.certainty],
  genitive: (a, want) => [a.genitiveSingular?.includes(want) ? want : a.genitiveSingular?.join('/')],
  case: (a) => [list(a.case), a.case?.certainty],
  number: (a) => [a.number?.value, a.number?.certainty],
  vnumber: (a) => [a.form?.number?.value, a.form?.number?.certainty],
  person: (a) => [list(a.form?.person), a.form?.person?.certainty],
  tense: (a) => [a.form?.tense?.value, a.form?.tense?.certainty],
  mood: (a) => [a.form?.mood?.value, a.form?.mood?.certainty],
  voice: (a) => [a.form?.voice?.value, a.form?.voice?.certainty],
  formKind: (a) => [a.form?.kind],
  role: (a) => [a.role],
  sep: (a) => [a.separable?.prefix],
  separated: (a) => [a.separable?.separated],
  prefixOf: (a) => [a.kind === 'verb' && a.role === 'prefix' ? a.infinitive : undefined],
  aux: (a, want) => [a.auxiliary?.value.includes(want) ? want : list(a.auxiliary), a.auxiliary?.certainty],
  pp: (a) => [a.partizip2],
  prt: (a) => [a.praeteritum],
  refl: (a) => [a.reflexive?.value ?? false, a.reflexive?.certainty],
  degree: (a) => [a.degree?.value, a.degree?.certainty],
  comparative: (a) => [a.comparative],
  superlative: (a) => [a.superlative],
};

/**
 * @param {object} o
 * @param {import('../../src/nlp/dictionary.ts').Dictionary} o.dict
 * @param {{id: string, cat: string, s: string, w: string, n?: number, expect: Record<string, unknown>}[]} o.cases
 * @param {(sentence: string) => Promise<unknown[] | undefined>} [o.parse] dependency parse provider
 */
export async function runGrammarCases({ dict, cases, parse }) {
  const byCat = new Map();
  const failures = [];
  const latencies = [];
  let checks = 0, checksOk = 0, wrongAndCertain = 0, wrongButFlagged = 0;

  for (const c of cases) {
    const index = tokenize(c.s).filter((t) => t.text === c.w)[c.n ?? 0]?.index;
    const parsed = parse ? await parse(c.s) : undefined;
    const t0 = performance.now();
    const words = await analyzeSentence(c.s, dict, { parse: parsed });
    latencies.push(performance.now() - t0);
    const a = index === undefined ? null : words[index];
    let ok = true;
    for (const [key, want] of Object.entries(c.expect)) {
      checks++;
      let actual, certainty;
      if (!a) actual = undefined;
      else if (key.startsWith('feature.')) {
        const f = a.features?.find((x) => x.key === key.slice(8));
        actual = f?.value.value;
        certainty = f?.value.certainty;
      } else [actual, certainty] = READERS[key](a, want);
      if (String(actual) === String(want)) {
        checksOk++;
        continue;
      }
      ok = false;
      // A wrong value presented as certain is the serious kind of error.
      if (actual !== undefined && (certainty === undefined || certainty === 'certain')) wrongAndCertain++;
      else wrongButFlagged++;
      failures.push(`${c.id} [${c.cat}] "${c.s}" → ${c.w}.${key}: expected ${want}, got ${actual}${certainty && certainty !== 'certain' ? ` (${certainty})` : ''}`);
    }
    const stat = byCat.get(c.cat) ?? { total: 0, passed: 0 };
    stat.total++;
    if (ok) stat.passed++;
    byCat.set(c.cat, stat);
  }

  const passed = [...byCat.values()].reduce((s, x) => s + x.passed, 0);
  latencies.sort((x, y) => x - y);
  return {
    cases: cases.length,
    casesPassed: passed,
    caseAccuracy: +((100 * passed) / cases.length).toFixed(1),
    checks,
    checksPassed: checksOk,
    checkAccuracy: +((100 * checksOk) / checks).toFixed(1),
    wrongButFlagged,
    wrongAndCertain,
    latencyMs: { median: +latencies[Math.floor(latencies.length / 2)].toFixed(1), p95: +latencies[Math.ceil(latencies.length * 0.95) - 1].toFixed(1) },
    categories: Object.fromEntries([...byCat].map(([k, v]) => [k, `${v.passed}/${v.total}`])),
    failures,
  };
}

// Builds the extension dictionary from three Wiktionary extracts (kaikki.org / Wiktextract):
//
//   data/raw/enwikt-de.jsonl.gz   English Wiktionary, German entries: inflection tables (primary source of forms)
//   data/raw/ruwikt-de.jsonl.gz   Russian Wiktionary, German entries: Russian glosses and translated examples
//   data/raw/dewikt-de.jsonl.gz   German Wiktionary: Russian translations per sense, German definitions,
//                                 synonyms, and forms for lemmas the English edition lacks
//   data/raw/de_50k.txt           word frequencies from film subtitles (ranking only)
//
// Output (data/dict): meta.json, e/<n>.json (entries, 500 per file, most frequent first) and
// f/<n>.json (inflected form -> entries, 512 hash buckets). The extension loads single shards on demand.
//
//   node data-pipeline/build-dict.mjs [--stats-only]
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const raw = join(root, 'data', 'raw');
const outDir = join(root, 'data', 'dict');
const statsOnly = process.argv.includes('--stats-only');

export const FORM_SHARDS = 512;
export const ENTRY_SHARD_SIZE = 500;

const POS = {
  noun: 'n', verb: 'v', adj: 'a', adv: 'adv', name: 'name', prep: 'prep', postp: 'prep', conj: 'conj', pron: 'pron',
  det: 'det', article: 'det', num: 'num', particle: 'part', intj: 'intj',
};
const CASES = ['nominative', 'genitive', 'dative', 'accusative'];
const USAGE = {
  colloquial: 'umgangssprachlich', informal: 'umgangssprachlich', vulgar: 'vulgär', derogatory: 'abwertend', pejorative: 'abwertend',
  archaic: 'veraltet', obsolete: 'veraltet', dated: 'veraltend', formal: 'gehoben', literary: 'gehoben', humorous: 'scherzhaft',
  rare: 'selten', Austria: 'österreichisch', Switzerland: 'schweizerisch', slang: 'Slang', regional: 'regional',
};

async function readJsonl(name, onEntry) {
  const rl = createInterface({ input: createReadStream(join(raw, name)).pipe(createGunzip()), crlfDelay: Infinity });
  let n = 0;
  for await (const line of rl) {
    if (!line) continue;
    onEntry(JSON.parse(line));
    n++;
  }
  return n;
}

// ───────────── lemma store ─────────────

/** word \t pos -> list of homonyms (nouns with different gender or plural stay apart). */
const groups = new Map();

function newSub(w, p) {
  return {
    w, p, src: new Set(), g: new Set(), pluralOnly: false,
    nforms: new Map(), gs: new Set(), pl: new Set(),
    vforms: new Map(), vp: {}, vt: null, pp: null, aux: [], sep: null, reflSenses: 0, senses: 0,
    cmp: null, sup: null, astems: new Map(), abare: new Map(),
    ruW: [], ruD: [], de: [], ex: null, exDe: null, syn: [], tg: new Set(),
  };
}

function compatible(sub, genders, plurals) {
  if (sub.p !== 'n') return true;
  if (genders.size > 0 && sub.g.size > 0 && ![...genders].some((g) => sub.g.has(g))) return false;
  if (plurals.size > 0 && sub.pl.size > 0 && ![...plurals].some((p) => sub.pl.has(p))) return false;
  return true;
}

/** Finds the homonym that matches gender and plural, or creates one. `forceNew` keeps separate etymologies apart. */
function getSub(w, p, genders = new Set(), plurals = new Set(), forceNew = false) {
  const key = `${w}\t${p}`;
  let list = groups.get(key);
  if (!list) groups.set(key, (list = []));
  if (!forceNew) {
    const found = list.find((s) => compatible(s, genders, plurals));
    if (found) return found;
  }
  const sub = newSub(w, p);
  list.push(sub);
  return sub;
}

// ───────────── form tags ─────────────

function nounSlot(tags) {
  const c = CASES.findIndex((name) => tags.includes(name));
  if (c < 0) return -1;
  if (tags.includes('plural')) return 4 + c;
  if (tags.includes('singular')) return c;
  return -1;
}

const SKIP_VERB = ['multiword-construction', 'table-tags', 'inflection-template', 'perfect', 'pluperfect', 'future-i', 'future-ii', 'future', 'processual-passive', 'statal-passive', 'statal-reflexive', 'honorific', 'gerundive', 'extended'];

/** Maps Wiktextract tags of a verb form to a compact code, or null. */
function verbCode(tags) {
  const person = tags.includes('first-person') ? 1 : tags.includes('second-person') ? 2 : tags.includes('third-person') ? 3 : 0;
  const number = tags.includes('plural') ? 'p' : tags.includes('singular') ? 's' : '';
  if (tags.includes('imperative')) return number ? `m${number}` : null;
  if (tags.includes('infinitive-zu')) return 'zu';
  if (tags.includes('participle') || tags.includes('participle-2') || tags.includes('participle-1')) {
    if (tags.includes('present') || tags.includes('participle-1')) return 'p1';
    if (tags.includes('past') || tags.includes('participle-2')) return 'p2';
    return null;
  }
  if (tags.includes('infinitive')) return 'inf';
  if (!person || !number) return null;
  if (tags.includes('subjunctive-i')) return `k1${person}${number}`;
  if (tags.includes('subjunctive-ii')) return `k2${person}${number}`;
  if (tags.includes('present')) return `ip${person}${number}`;
  if (tags.includes('preterite') || tags.includes('past')) return `it${person}${number}`;
  return null;
}

function addVerbForm(sub, form, tags) {
  if (SKIP_VERB.some((t) => tags.includes(t))) return;
  // The German edition tags every row of a conjugation page with "auxiliary"; only a row that
  // consists of haben/sein itself names the auxiliary of the verb.
  if (tags.includes('auxiliary') && /^(haben|sein)(\s+or\s+(haben|sein))?$/.test(form) && !tags.includes('infinitive')) {
    for (const aux of form.split(/\s+or\s+/)) if (!sub.aux.includes(aux)) sub.aux.push(aux);
    return;
  }
  let text = form.replace(/!$/, '').trim();
  if (!text || /[()\[\]]/.test(text)) return;
  const code = verbCode(tags);
  // Principal parts from the headword line.
  if (!code) {
    if (tags.length === 1 && tags[0] === 'past' && !sub.vt) sub.vt = text;
    return;
  }
  const parts = text.split(' ');
  if (parts.length === 2 && !tags.includes('subordinate-clause')) {
    // Main-clause form of a separable verb: "stehe auf". Shown in the panel, resolved at runtime
    // through the base verb, therefore not indexed.
    sub.sep ??= parts[1];
    if (/^ip\d[sp]$/.test(code) && !sub.vp[code]) sub.vp[code] = text;
    if ((code === 'it1s' || code === 'it3s') && !sub.vt) sub.vt = text;
    return;
  }
  if (parts.length !== 1) return;
  if (tags.includes('rare') && tags.includes('formal') && code.startsWith('k2')) text = parts[0];
  let set = sub.vforms.get(text);
  if (!set) sub.vforms.set(text, (set = new Set()));
  set.add(code);
  if (/^ip\d[sp]$/.test(code) && !sub.vp[code] && !tags.includes('subordinate-clause')) sub.vp[code] = text;
  if ((code === 'it1s' || code === 'it3s') && !sub.vt && !tags.includes('subordinate-clause')) sub.vt = text;
  if (code === 'p2' && !sub.pp) sub.pp = text;
}

function addNounForm(sub, form, tags) {
  if (!form || form.includes(' ') || tags.includes('alternative') || tags.includes('diminutive') || tags.includes('variant')) return;
  const slot = nounSlot(tags);
  if (slot < 0) return;
  sub.nforms.set(form, (sub.nforms.get(form) ?? 0) | (1 << slot));
}

function degreeOf(tags) {
  return tags.includes('superlative') ? 2 : tags.includes('comparative') ? 1 : 0;
}

function lcp(words) {
  if (words.length === 0) return '';
  let prefix = words[0];
  for (const w of words) while (!w.startsWith(prefix)) prefix = prefix.slice(0, -1);
  return prefix;
}

/** Declined adjective forms per degree -> stem that takes the endings -e, -er, -es, -en, -em. */
function finishAdjective(sub, declined) {
  for (let d = 0; d < 3; d++) {
    const forms = [...declined[d]];
    if (forms.length < 3) continue;
    let stem = lcp(forms);
    if (stem.endsWith('e')) stem = stem.slice(0, -1);
    if (stem.length < 2) continue;
    if (!forms.every((f) => /^(e|er|es|en|em)$/.test(f.slice(stem.length)))) continue;
    sub.astems.set(stem, d);
  }
}

// ───────────── pass 1: English Wiktionary ─────────────

const formOf = []; // [form, pos, lemma, tags]
const stats = { en: 0, enLemmas: 0, ru: 0, ruLemmas: 0, de: 0, deLemmas: 0 };

function isLemma(e) {
  return (e.senses ?? []).some((s) => !s.form_of && !(s.tags ?? []).includes('form-of'));
}

function usageTags(sub, sense) {
  for (const t of sense?.tags ?? []) if (USAGE[t]) sub.tg.add(USAGE[t]);
}

function ingestEnglish(e) {
  stats.en++;
  const p = POS[e.pos];
  if (!p || !e.word || /\s/.test(e.word)) return;
  const senses = e.senses ?? [];
  if (!isLemma(e)) {
    if (p === 'v' || p === 'n') {
      for (const s of senses) {
        const lemma = s.form_of?.[0]?.word;
        if (lemma && !/\s/.test(lemma)) formOf.push([e.word, p, lemma, s.tags ?? []]);
      }
    }
    return;
  }
  stats.enLemmas++;
  const lemmaSenses = senses.filter((s) => !s.form_of);
  const forms = e.forms ?? [];
  const genders = new Set();
  let pluralOnly = false;
  for (const s of lemmaSenses) {
    for (const t of s.tags ?? []) {
      if (t === 'masculine') genders.add('m');
      else if (t === 'feminine') genders.add('f');
      else if (t === 'neuter') genders.add('n');
    }
  }
  // "Äpfel" has one slang sense that exists only in the plural; that does not make the noun plural-only.
  pluralOnly = lemmaSenses.length > 0 && lemmaSenses.every((s) => (s.tags ?? []).includes('plural-only'));
  const headPlurals = new Set(forms.filter((f) => !f.source && f.tags?.length === 1 && f.tags[0] === 'plural').map((f) => f.form));
  const sub = getSub(e.word, p, genders, headPlurals, p === 'n');
  sub.src.add('en');
  usageTags(sub, lemmaSenses[0]);

  if (p === 'n' || p === 'name') {
    for (const g of genders) sub.g.add(g);
    sub.pluralOnly ||= pluralOnly;
    for (const f of forms) {
      const tags = f.tags ?? [];
      if (!f.source) {
        if (tags.length === 1 && tags[0] === 'genitive' && !f.form.includes(' ')) sub.gs.add(f.form);
        if (tags.length === 1 && tags[0] === 'plural' && !f.form.includes(' ')) sub.pl.add(f.form);
      } else if (f.source === 'declension') {
        addNounForm(sub, f.form, tags);
      }
    }
  } else if (p === 'v') {
    for (const f of forms) addVerbForm(sub, f.form, f.tags ?? []);
    sub.senses += lemmaSenses.length;
    sub.reflSenses += lemmaSenses.filter((s) => (s.tags ?? []).includes('reflexive')).length;
  } else if (p === 'a' || p === 'adv') {
    const declined = [new Set(), new Set(), new Set()];
    for (const f of forms) {
      const tags = f.tags ?? [];
      if (!f.form || f.form.includes(' ') && !f.form.startsWith('am ')) continue;
      if (!f.source) {
        const plain = !tags.some((t) => t !== 'comparative' && t !== 'superlative');
        if (tags.includes('comparative') && plain && !sub.cmp) sub.cmp = f.form;
        if (tags.includes('superlative') && plain && !sub.sup) sub.sup = f.form;
        continue;
      }
      if (f.source !== 'declension' || f.form.includes(' ')) continue;
      const d = degreeOf(tags);
      if (tags.includes('predicative')) sub.abare.set(f.form, d);
      else if (CASES.some((c) => tags.includes(c))) declined[d].add(f.form);
    }
    if (p === 'a') finishAdjective(sub, declined);
  }
}

// ───────────── pass 2: Russian Wiktionary ─────────────

function cleanGloss(text, max = 96) {
  let t = String(text ?? '').replace(/\s+/g, ' ').replace(/[;,.\s]+$/, '').trim();
  if (t.length > max) {
    const cut = t.lastIndexOf(' ', max);
    t = `${t.slice(0, cut > 40 ? cut : max).replace(/[;,.\s]+$/, '')}…`;
  }
  return t;
}

function ingestRussian(e) {
  stats.ru++;
  const p = POS[e.pos];
  if (!p || !e.word || /\s/.test(e.word)) return;
  const senses = (e.senses ?? []).filter((s) => !s.form_of && !(s.tags ?? []).includes('form-of'));
  const glosses = senses.map((s) => cleanGloss(s.glosses?.[0])).filter((g) => g.length > 0 && /[а-яё]/i.test(g));
  if (glosses.length === 0) return;
  stats.ruLemmas++;
  const genders = new Set();
  for (const t of e.tags ?? []) {
    if (t === 'masculine') genders.add('m');
    else if (t === 'feminine') genders.add('f');
    else if (t === 'neuter') genders.add('n');
  }
  const plurals = new Set((e.forms ?? []).filter((f) => f.tags?.includes('plural') && f.tags?.includes('nominative')).map((f) => f.form));
  const sub = getSub(e.word, p, genders, plurals);
  sub.src.add('ru');
  if (p === 'n') for (const g of genders) sub.g.add(g);
  for (const g of glosses) if (!sub.ruW.includes(g)) sub.ruW.push(g);
  if (!sub.ex) {
    for (const s of senses) {
      const ex = (s.examples ?? []).find((x) => x.text && x.translation && x.text.length <= 110 && x.translation.length <= 130);
      if (ex) {
        sub.ex = [ex.text.trim(), ex.translation.trim()];
        break;
      }
    }
  }
}

// ───────────── pass 3: German Wiktionary ─────────────

function ingestGerman(e) {
  stats.de++;
  if ((e.tags ?? []).includes('form-of')) return;
  const p = POS[e.pos];
  if (!p || !e.word || /\s/.test(e.word)) return;
  const senses = (e.senses ?? []).filter((s) => !s.form_of);
  if (senses.length === 0) return;
  stats.deLemmas++;
  const tags = e.tags ?? [];
  const genders = new Set();
  if (tags.includes('masculine')) genders.add('m');
  if (tags.includes('feminine')) genders.add('f');
  if (tags.includes('neuter')) genders.add('n');
  const forms = e.forms ?? [];
  const plurals = new Set(forms.filter((f) => f.tags?.includes('nominative') && f.tags?.includes('plural') && !f.form.includes(' ')).map((f) => f.form));
  const sub = getSub(e.word, p, genders, plurals);
  const hadEnglish = sub.src.has('en');
  sub.src.add('de');

  // Russian translations, grouped by sense in dictionary order.
  const bySense = new Map();
  for (const t of e.translations ?? []) {
    if ((t.lang_code ?? t.code) !== 'ru' || !t.word) continue;
    const word = cleanGloss(t.word, 60);
    if (!/[а-яё]/i.test(word)) continue;
    const key = String(t.sense_index ?? '');
    if (!bySense.has(key)) bySense.set(key, []);
    if (!bySense.get(key).includes(word)) bySense.get(key).push(word);
  }
  for (const words of bySense.values()) {
    const joined = words.slice(0, 4).join(', ');
    if (!sub.ruD.includes(joined)) sub.ruD.push(joined);
  }
  for (const s of senses.slice(0, 2)) {
    const gloss = cleanGloss(s.glosses?.[0], 110);
    if (gloss && sub.de.length < 2 && !sub.de.includes(gloss)) sub.de.push(gloss);
  }
  if (!sub.exDe) {
    const ex = senses.flatMap((s) => s.examples ?? []).find((x) => x.text && x.text.length >= 12 && x.text.length <= 90 && !x.ref);
    if (ex) sub.exDe = ex.text.replace(/[„“"»«]/g, '').trim();
  }
  for (const s of e.synonyms ?? []) if (s.word && !/\s/.test(s.word) && sub.syn.length < 4 && !sub.syn.includes(s.word)) sub.syn.push(s.word);

  if (p === 'n') {
    if (sub.g.size === 0) for (const g of genders) sub.g.add(g);
    if (!hadEnglish) {
      for (const f of forms) addNounForm(sub, f.form, f.tags ?? []);
      for (const [form, mask] of sub.nforms) {
        if (mask & (1 << 1)) sub.gs.add(form);
        if (mask & (1 << 4)) sub.pl.add(form);
      }
    }
  } else if (p === 'v') {
    if (!hadEnglish) {
      for (const f of forms) addVerbForm(sub, f.form, f.tags ?? []);
      sub.senses += senses.length;
    }
    if (tags.includes('reflexive')) sub.reflSenses = Math.max(sub.reflSenses, 1);
    const germanOrder = forms.filter((f) => (f.form === 'haben' || f.form === 'sein') && (f.tags ?? []).includes('auxiliary') && !(f.tags ?? []).includes('infinitive')).map((f) => f.form);
    const order = [...new Set(germanOrder)];
    if (order.length > 0 && order.every((a) => sub.aux.includes(a) || sub.aux.length === 0)) {
      // Keep auxiliaries both editions agree on, in the order of the German edition.
      sub.aux = sub.aux.length === 0 ? order : [...order, ...sub.aux.filter((a) => !order.includes(a))];
    }
  } else if (p === 'a' && !hadEnglish) {
    const declined = [new Set(), new Set(), new Set()];
    for (const f of forms) {
      const ftags = f.tags ?? [];
      if (!f.form) continue;
      const d = degreeOf(ftags);
      if (!CASES.some((c) => ftags.includes(c))) {
        if (d === 1 && !sub.cmp && !f.form.includes(' ')) sub.cmp = f.form;
        if (d === 2 && !sub.sup) sub.sup = f.form;
        continue;
      }
      if (!f.form.includes(' ')) declined[d].add(f.form);
    }
    finishAdjective(sub, declined);
  }
}

// ───────────── merge and emit ─────────────

function mergeRussian(sub) {
  const out = [...sub.ruW];
  const seen = out.join(' | ').toLowerCase();
  for (const t of sub.ruD) {
    const fresh = t.split(', ').filter((w) => !seen.includes(w.toLowerCase()));
    if (fresh.length > 0) out.push(fresh.join(', '));
  }
  return out.slice(0, 6);
}

function finalize(sub) {
  const e = { w: sub.w, p: sub.p };
  const ru = mergeRussian(sub);
  if (ru.length) e.ru = ru;
  if (sub.tg.size) e.tg = [...sub.tg].slice(0, 3);
  if (sub.p === 'n' || sub.p === 'name') {
    if (sub.pluralOnly) e.g = 'p';
    else if (sub.g.size) e.g = ['m', 'f', 'n'].filter((g) => sub.g.has(g)).join('');
    if (sub.gs.size) e.gs = [...sub.gs].slice(0, 2);
    if (sub.pl.size) e.pl = [...sub.pl].slice(0, 2);
    // Weak masculine nouns: "den Studenten".
    const acc = [...sub.nforms].find(([form, mask]) => mask & (1 << 3) && form !== sub.w);
    if (acc && ![...sub.nforms].some(([form, mask]) => form === sub.w && mask & (1 << 3))) e.as = acc[0];
  } else if (sub.p === 'v') {
    const vp = ['ip1s', 'ip2s', 'ip3s', 'ip1p', 'ip2p', 'ip3p'].map((c) => sub.vp[c] ?? '');
    if (vp.every(Boolean)) e.vp = vp;
    if (sub.vt) e.vt = sub.vt;
    if (sub.pp) e.pp = sub.pp;
    if (sub.aux.length) e.aux = sub.aux.map((a) => a[0]).join('');
    if (sub.sep) e.sep = sub.sep;
    if (sub.reflSenses > 0) e.refl = sub.senses > 0 && sub.reflSenses >= sub.senses ? 1 : 2;
  } else if (sub.p === 'a' || sub.p === 'adv') {
    if (sub.cmp) e.cmp = sub.cmp;
    if (sub.sup) e.sup = sub.sup;
  }
  return e;
}

function fnv1a(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const hex2 = (n) => n.toString(16).padStart(2, '0');

async function main() {
  const t0 = Date.now();
  await readJsonl('enwikt-de.jsonl.gz', ingestEnglish);
  console.log(`enwikt: ${stats.en} entries, ${stats.enLemmas} lemma entries (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  await readJsonl('ruwikt-de.jsonl.gz', ingestRussian);
  console.log(`ruwikt: ${stats.ru} entries, ${stats.ruLemmas} with Russian glosses`);
  await readJsonl('dewikt-de.jsonl.gz', ingestGerman);
  console.log(`dewikt: ${stats.de} entries, ${stats.deLemmas} lemma entries (${((Date.now() - t0) / 1000).toFixed(0)} s)`);

  // Flatten, build the form index with temporary ids.
  const subs = [];
  for (const list of groups.values()) for (const sub of list) { sub.tid = subs.length; subs.push(sub); }
  const index = new Map(); // form -> Map<tempId, Set<code>>
  const add = (form, id, code) => {
    let ids = index.get(form);
    if (!ids) index.set(form, (ids = new Map()));
    let codes = ids.get(id);
    if (!codes) ids.set(id, (codes = new Set()));
    codes.add(code);
  };
  subs.forEach((sub, id) => {
    if (sub.p === 'n' || sub.p === 'name') {
      if (sub.nforms.size === 0) {
        // No table: reconstruct the regular slots from the headword forms.
        if (!sub.pluralOnly) sub.nforms.set(sub.w, 0b1101);
        for (const g of sub.gs) sub.nforms.set(g, (sub.nforms.get(g) ?? 0) | 0b0010);
        for (const pl of sub.pl) {
          sub.nforms.set(pl, (sub.nforms.get(pl) ?? 0) | 0b10110000);
          const dat = /[ns]$/.test(pl) ? pl : `${pl}n`;
          sub.nforms.set(dat, (sub.nforms.get(dat) ?? 0) | 0b01000000);
        }
        if (sub.pluralOnly && sub.nforms.size === 0) sub.nforms.set(sub.w, 0b10110000);
      }
      for (const [form, mask] of sub.nforms) add(form, id, `N${hex2(mask)}`);
      if (!sub.nforms.has(sub.w)) add(sub.w, id, sub.pluralOnly ? 'Nb0' : 'N0d');
    } else if (sub.p === 'v') {
      for (const [form, codes] of sub.vforms) for (const code of codes) add(form, id, code);
      add(sub.w, id, 'inf');
    } else if (sub.p === 'a') {
      add(sub.w, id, 'A0');
      for (const [form, d] of sub.abare) add(form, id, `A${d}`);
      if (sub.cmp && !sub.cmp.includes(' ')) add(sub.cmp, id, 'A1');
      for (const [stem, d] of sub.astems) add(stem, id, `a${d}`);
    } else {
      add(sub.w, id, 'X');
    }
  });

  // Inflected-form entries fill gaps for lemmas that came without a table.
  let formOfAdded = 0;
  for (const [form, p, lemma, tags] of formOf) {
    const list = groups.get(`${lemma}\t${p}`);
    if (!list) continue;
    const sub = list[0];
    const id = sub.tid;
    if (index.get(form)?.has(id)) continue;
    if (p === 'v') {
      const code = verbCode(tags);
      if (code) { add(form, id, code); formOfAdded++; }
    } else {
      const slot = nounSlot(tags);
      if (slot >= 0) { add(form, id, `N${hex2(1 << slot)}`); formOfAdded++; }
    }
  }

  // Frequency score. The subtitle word list is lower-cased and counts surface forms, so every
  // count is shared among the lemmas that the form can belong to. Unlikely readings get a small
  // share: "hat" is almost always haben, hardly ever the imperative of the slang verb "haten".
  const score = new Float64Array(subs.length);
  const freqFile = join(raw, 'de_50k.txt');
  if (existsSync(freqFile)) {
    const weightOf = (codes, capitalizedOnly, lowerExists) => {
      const list = [...codes];
      if (list[0].startsWith('N')) return capitalizedOnly && lowerExists ? 0.08 : 1;
      if (list[0] === 'X' || /^A\d$/.test(list[0])) return 1;
      if (/^a\d$/.test(list[0])) return 0.5;
      if (list.some((c) => /^(ip|it)/.test(c) || c === 'inf' || c === 'p2' || c === 'zu')) return 1;
      if (list.some((c) => /^k[12]/.test(c))) return 0.1;
      return 0.03; // imperative only
    };
    for (const line of readFileSync(freqFile, 'utf8').split('\n')) {
      const [word, countText] = line.split(' ');
      const count = Number(countText);
      if (!word || !(count > 0)) continue;
      const lower = index.get(word);
      const upper = index.get(word[0].toUpperCase() + word.slice(1));
      const shares = [];
      if (lower) for (const [id, codes] of lower) shares.push([id, weightOf(codes, false, true)]);
      if (upper) for (const [id, codes] of upper) shares.push([id, weightOf(codes, true, Boolean(lower))]);
      // Declined adjectives ("gute", "kleinen") are indexed by stem.
      for (const ending of ['em', 'en', 'er', 'es', 'e']) {
        if (!word.endsWith(ending) || word.length - ending.length < 2) continue;
        const stem = index.get(word.slice(0, -ending.length));
        if (stem) for (const [id, codes] of stem) if ([...codes].some((c) => /^[aA]\d$/.test(c))) shares.push([id, 0.5]);
      }
      const total = shares.reduce((sum, [, w]) => sum + w, 0);
      for (const [id, w] of shares) score[id] += (count * w) / total;
    }
  }
  const rank = Array.from(score, (s) => (s > 0 ? 1 : -1));
  const ranked = rank.filter((r) => r > 0).length;

  const hasRussian = (sub) => (sub.ruW.length + sub.ruD.length > 0 ? 1 : 0);
  // Keep what a learner can use: a Russian meaning, or grammar for a word that occurs in speech.
  const lowerCaseTwin = (sub) => sub.p === 'n' && sub.w.length > 1 && sub.w[0] !== sub.w[0].toUpperCase() && groups.has(`${sub.w[0].toUpperCase()}${sub.w.slice(1)}	n`);
  const keep = subs.map((sub, id) => !lowerCaseTwin(sub) && (sub.ruW.length + sub.ruD.length > 0 || score[id] > 0 || (sub.src.has('en') && ['n', 'v', 'a'].includes(sub.p))));
  // Most frequent first: a lower id means a more likely reading, which the analyser relies on.
  const order = subs.map((_, id) => id).filter((id) => keep[id]).sort((a, b) => score[b] - score[a] || hasRussian(subs[b]) - hasRussian(subs[a]) || subs[a].w.localeCompare(subs[b].w, 'de'));
  const newId = new Int32Array(subs.length).fill(-1);
  order.forEach((old, id) => { newId[old] = id; });

  const entries = order.map((old) => {
    const sub = subs[old];
    const e = finalize(sub);
    const frequent = rank[old] >= 0;
    if (frequent || !e.ru) { if (sub.de.length) e.de = sub.de.slice(0, frequent ? 2 : 1); }
    if (frequent) {
      if (sub.ex) e.ex = sub.ex;
      else if (sub.exDe) e.ex = [sub.exDe];
      if (sub.syn.length) e.syn = sub.syn;
    }
    return e;
  });

  const shards = Array.from({ length: FORM_SHARDS }, () => ({}));
  let pairs = 0;
  for (const [form, ids] of index) {
    const parts = [];
    for (const [old, codes] of ids) {
      if (newId[old] < 0) continue;
      parts.push([newId[old], `${newId[old]}:${[...codes].join(',')}`]);
    }
    if (parts.length === 0) continue;
    parts.sort((a, b) => a[0] - b[0]);
    pairs += parts.length;
    shards[fnv1a(form.toLowerCase()) % FORM_SHARDS][form] = parts.map((x) => x[1]).join(';');
  }

  const byPos = {};
  let withRu = 0;
  for (const e of entries) { byPos[e.p] = (byPos[e.p] ?? 0) + 1; if (e.ru) withRu++; }
  const top = (n) => entries.slice(0, n);
  const coverage = (n) => `${((100 * top(n).filter((e) => e.ru).length) / n).toFixed(1)}%`;
  const meta = {
    schema: 1,
    version: new Date().toISOString().slice(0, 10),
    entries: entries.length,
    formShards: FORM_SHARDS,
    entryShardSize: ENTRY_SHARD_SIZE,
    forms: index.size,
    pairs,
    stats: { byPos, withRussian: withRu, rankedLemmas: ranked, formOfAdded, russianCoverageTop: { 1000: coverage(1000), 5000: coverage(5000), 10000: coverage(10000), 20000: coverage(20000) } },
    sources: [
      'English Wiktionary via kaikki.org (Wiktextract), CC BY-SA 4.0 / GFDL',
      'Russian Wiktionary via kaikki.org (Wiktextract), CC BY-SA 4.0 / GFDL',
      'German Wiktionary via kaikki.org (Wiktextract), CC BY-SA 4.0 / GFDL',
      'FrequencyWords de_50k (OpenSubtitles 2018), CC BY-SA 4.0, used for ranking only',
    ],
  };
  console.log(JSON.stringify(meta, null, 1));
  if (statsOnly) return;

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(join(outDir, 'e'), { recursive: true });
  mkdirSync(join(outDir, 'f'), { recursive: true });
  let bytes = 0;
  const write = (path, data) => {
    const text = JSON.stringify(data);
    bytes += Buffer.byteLength(text);
    writeFileSync(join(outDir, path), text);
  };
  write('meta.json', meta);
  for (let i = 0; i * ENTRY_SHARD_SIZE < entries.length; i++) write(`e/${i}.json`, entries.slice(i * ENTRY_SHARD_SIZE, (i + 1) * ENTRY_SHARD_SIZE));
  shards.forEach((shard, i) => write(`f/${i}.json`, shard));
  console.log(`written ${(bytes / 1048576).toFixed(1)} MB to data/dict in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}

await main();

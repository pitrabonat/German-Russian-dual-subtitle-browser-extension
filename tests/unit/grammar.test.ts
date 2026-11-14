// Grammar engine against the compiled dictionary (data/dict). Skipped when the dictionary
// has not been built yet (`npm run dict:build`).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildPopupView } from '../../src/content/overlay/wordView.ts';
import { analyzeSentence } from '../../src/nlp/analyzer.ts';
import { ShardDictionary } from '../../src/nlp/dictionary.ts';
import { tokenize } from '../../src/shared/text.ts';
import type { NounAnalysis, VerbAnalysis, WordAnalysis } from '../../src/shared/types';
// @ts-expect-error plain JavaScript helper shared with the command-line evaluation
import { runGrammarCases } from '../eval/grammar-lib.mjs';

const root = join(import.meta.dirname, '..', '..');
const dictDir = join(root, 'data', 'dict');
const dict = new ShardDictionary(async (path) => JSON.parse(readFileSync(join(dictDir, path), 'utf8')) as unknown);

async function word(sentence: string, text: string, translation?: string): Promise<WordAnalysis> {
  const words = await analyzeSentence(sentence, dict, { translation });
  const token = tokenize(sentence).find((t) => t.text === text);
  const analysis = token ? words[token.index] : null;
  if (!analysis) throw new Error(`no analysis for "${text}"`);
  return analysis;
}

describe.skipIf(!existsSync(join(dictDir, 'meta.json')))('grammar engine', () => {
  it('links a detached prefix to its verb', async () => {
    const sentence = 'Ich stehe jeden Morgen um sieben Uhr auf.';
    const verb = (await word(sentence, 'stehe')) as VerbAnalysis;
    const prefix = (await word(sentence, 'auf')) as VerbAnalysis;
    expect(verb.kind).toBe('verb');
    expect(verb.infinitive).toBe('aufstehen');
    expect(verb.separable).toMatchObject({ prefix: 'auf', separated: true });
    expect(verb.partizip2).toBe('aufgestanden');
    expect(verb.praeteritum).toBe('stand auf');
    expect(verb.form.tense?.value).toBe('present');
    expect(verb.form.person?.value).toEqual([1]);
    expect(prefix).toMatchObject({ kind: 'verb', role: 'prefix', infinitive: 'aufstehen' });
    // Both halves point at each other, which is what the overlay highlights.
    expect(verb.separable?.prefixTokenIndex).toBe(prefix.tokenIndex);
    expect(prefix.separable?.verbTokenIndex).toBe(verb.tokenIndex);
  });

  it('does not mistake a preposition for a verb prefix', async () => {
    const verb = (await word('Ich warte auf den Bus.', 'warte')) as VerbAnalysis;
    expect(verb.infinitive).toBe('warten');
    expect(verb.separable).toBeUndefined();
    expect((await word('Ich warte auf den Bus.', 'auf')).pos.value).toBe('preposition');
  });

  it('reports gender, plural and case of a noun and how sure it is', async () => {
    const noun = (await word('Die Kinder spielen draußen im Garten.', 'Garten')) as NounAnalysis;
    expect(noun.kind).toBe('noun');
    expect(noun.gender?.value).toEqual(['m']);
    expect(noun.plural?.value).toContain('Gärten');
    expect(noun.case).toMatchObject({ value: ['dative'], certainty: 'certain' });
    // "die Kinder" could be nominative or accusative by form; the engine decides and says so.
    const kinder = (await word('Die Kinder spielen draußen im Garten.', 'Kinder')) as NounAnalysis;
    expect(kinder.lemma.value).toBe('Kind');
    expect(kinder.case).toMatchObject({ value: ['nominative'], certainty: 'likely' });
    expect(kinder.number?.value).toBe('plural');
  });

  it('recognises compound tenses and the passive', async () => {
    const perfect = (await word('Er hat mich gestern angerufen.', 'angerufen')) as VerbAnalysis;
    expect(perfect.infinitive).toBe('anrufen');
    expect(perfect.form).toMatchObject({ kind: 'participle2', tense: { value: 'perfect' } });
    expect(((await word('Er hat mich gestern angerufen.', 'hat')) as VerbAnalysis).role).toBe('auxiliary');
    const passive = (await word('Das Haus wird gerade renoviert.', 'renoviert')) as VerbAnalysis;
    expect(passive.form.voice?.value).toBe('passive');
  });

  it('uses the sentence translation to pick the meaning in context', async () => {
    const withContext = await word('Die Bank ist heute geschlossen.', 'Bank', 'Банк сегодня закрыт.');
    expect(withContext.translation.contextual).toMatchObject({ value: 'банк', certainty: 'likely' });
    const without = await word('Die Bank ist heute geschlossen.', 'Bank');
    expect(without.translation.contextual?.certainty).toBe('uncertain');
    expect(without.translation.senses.length).toBeGreaterThan(1);
  });

  it('marks unknown words as unknown instead of inventing an analysis', async () => {
    const unknown = await word('Der Xyzzyplex ist kaputt.', 'Xyzzyplex');
    expect(unknown.pos.certainty).toBe('uncertain');
    expect(unknown.translation.senses).toEqual([]);
    expect(unknown.translation.contextual).toBeUndefined();
  });

  it('builds the word panel from the structured analysis', async () => {
    const verb = buildPopupView(await word('Ich stehe jeden Morgen um sieben Uhr auf.', 'stehe', 'Я встаю каждое утро в семь часов.'));
    expect(verb.title).toBe('aufstehen');
    expect(verb.tags).toEqual(['Verb', 'trennbar']);
    expect(verb.translation).toMatchObject({ text: 'вставать', uncertain: true });
    expect(verb.rows.map((r) => r.label)).toEqual(expect.arrayContaining(['Im Satz', 'Präteritum', 'Partizip II', 'Hilfsverb', 'Präfix']));
    expect(verb.rows.find((r) => r.label === 'Im Satz')?.value).toBe('Präsens, 1. Person Singular');
    expect(verb.conjugation?.[0]).toEqual(['ich', 'stehe auf']);
    const noun = buildPopupView(await word('Er stellt die Vase auf den Tisch.', 'Tisch'));
    expect(noun.article).toEqual({ text: 'der', cls: 'm' });
    expect(noun.rows.find((r) => r.label === 'Im Satz')?.value).toBe('Akkusativ Singular');
    expect(noun.rows.find((r) => r.label === 'Plural')?.value).toBe('die Tische');
  });

  it('keeps its accuracy on the development cases and never presents a wrong value as certain', async () => {
    const { cases } = JSON.parse(readFileSync(join(root, 'tests', 'data', 'grammar-cases.json'), 'utf8')) as { cases: unknown[] };
    const result = (await runGrammarCases({ dict, cases })) as { cases: number; caseAccuracy: number; wrongAndCertain: number; failures: string[] };
    expect(result.cases).toBeGreaterThanOrEqual(100);
    expect(result.caseAccuracy, result.failures.join('\n')).toBeGreaterThanOrEqual(97);
    expect(result.wrongAndCertain, result.failures.join('\n')).toBe(0);
  });
});

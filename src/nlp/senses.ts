// Chooses the dictionary sense that fits the sentence, using the Russian translation of the
// sentence as evidence: if one of the candidate equivalents occurs there, that is the meaning.
import type { Marked, TranslationInfo } from '../shared/types';

function commonPrefix(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

/** Loose match of two Russian word forms: same beginning, different ending. */
export function sameRussianWord(a: string, b: string): boolean {
  const cp = commonPrefix(a, b);
  if (cp >= 5) return true;
  const shorter = Math.min(a.length, b.length);
  if (cp >= 4) return cp >= shorter - 3;
  return cp >= 3 && shorter <= 4 && cp === shorter;
}

export function russianWords(text: string): string[] {
  return (text.toLowerCase().replace(/ё/g, 'е').match(/[а-я]+/g) ?? []).filter((w) => w.length >= 3);
}

/** Splits a dictionary sense such as "стол (предмет мебели); обед" into its equivalents. */
export function equivalents(sense: string): string[] {
  return sense
    .replace(/\([^)]*\)/g, ' ')
    .replace(/^[а-яё]{2,6}\.\s+/i, '') // usage labels: "разг. …", "устар. …"
    .split(/[,;]/)
    .map((part) => part.replace(/\s+/g, ' ').replace(/…$/, '').trim())
    .filter((part) => part.length > 0);
}

/**
 * Builds the translation block of a word: the meaning in context first, the full sense list
 * after it. Without a matching equivalent the first sense is offered and marked as a guess.
 */
export function pickSense(senses: readonly string[], sentenceTranslation: string | undefined, machine = false): TranslationInfo {
  if (senses.length === 0) return { senses: [] };
  const source = machine ? 'mt' : 'dictionary';
  if (sentenceTranslation) {
    const context = russianWords(sentenceTranslation);
    for (const sense of senses) {
      for (const candidate of equivalents(sense)) {
        const words = russianWords(candidate);
        if (words.length === 0 || words.length > 3) continue;
        if (words.every((w) => context.some((c) => sameRussianWord(w, c)))) {
          return { contextual: { value: candidate, certainty: machine ? 'uncertain' : 'likely', source }, senses: [...senses] };
        }
      }
    }
  }
  const first = equivalents(senses[0]!)[0] ?? senses[0]!;
  const single = senses.length === 1 && equivalents(senses[0]!).length === 1;
  const contextual: Marked<string> = { value: first, certainty: single && !machine ? 'likely' : 'uncertain', source };
  return { contextual, senses: [...senses] };
}

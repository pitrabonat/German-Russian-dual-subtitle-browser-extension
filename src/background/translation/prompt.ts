// Prompts for LLM-based translation (Ollama). Kept free of browser APIs so that the
// benchmark scripts under tests/eval can import the very same code.

/** Part of every cache key: bump when the wording changes so that old translations are not reused. */
export const PROMPT_VERSION = 2;

export interface PromptUnit {
  text: string;
  before: string[];
  after: string[];
}

export interface OllamaChatRequest {
  model: string;
  stream: false;
  think?: false;
  keep_alive: string;
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[];
  options: { temperature: number; top_p: number; num_predict: number; num_ctx: number; seed: number };
  format?: unknown;
}

const SYSTEM_PROMPT = `Ты профессиональный переводчик субтитров с немецкого на русский.

Правила:
1. Передавай смысл, а не отдельные слова. Идиомы и разговорные выражения заменяй естественными русскими соответствиями.
2. Перевод должен быть таким же коротким, как оригинал: это субтитры.
3. Контекст дан только для понимания. Его переводить не нужно.
4. Строка может быть обрывком предложения. Переведи только её, так чтобы она сочеталась с соседними строками.
5. В ответе только русский перевод строки: без кавычек, пояснений и немецкого текста.

Примеры:
Ich verstehe nur Bahnhof. → Я ничего не понимаю.
Er steht jeden Tag um sechs auf. → Он встаёт каждый день в шесть.
Das ist mir Wurst. → Мне всё равно.`;

function userMessage(unit: PromptUnit): string {
  const parts: string[] = [];
  if (unit.before.length > 0) parts.push(`Контекст до:\n${unit.before.join('\n')}`);
  if (unit.after.length > 0) parts.push(`Контекст после:\n${unit.after.join('\n')}`);
  parts.push(`Строка для перевода:\n${unit.text}`);
  return parts.join('\n\n');
}

const BASE_OPTIONS = { temperature: 0, top_p: 1, num_ctx: 2048, seed: 7 } as const;

/** Request body for translating one subtitle unit. */
export function buildChatRequest(model: string, unit: PromptUnit, withThinkFlag = true): OllamaChatRequest {
  const request: OllamaChatRequest = {
    model,
    stream: false,
    keep_alive: '20m',
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userMessage(unit) },
    ],
    // A subtitle line rarely needs more than 60 tokens; the cap bounds runaway generations.
    options: { ...BASE_OPTIONS, num_predict: Math.min(320, 48 + Math.ceil(unit.text.length * 0.9)) },
  };
  // Reasoning models (qwen3, deepseek-r1, …) would spend seconds on hidden thoughts otherwise.
  if (withThinkFlag) request.think = false;
  return request;
}

const WORD_SYSTEM_PROMPT = `Ты помогаешь учить немецкий. Тебе дают немецкое предложение и одно слово из него.
Ответь, что это слово значит именно в этом предложении: один русский перевод, от одного до четырёх слов, в начальной форме.
Если слово входит в устойчивое выражение или это отделяемая приставка глагола, переведи выражение или глагол целиком.
В ответе только перевод, без пояснений.

Примеры:
Предложение: Ich stehe jeden Morgen um sieben auf.
Слово: stehe
вставать

Предложение: Die Bank ist heute geschlossen.
Слово: Bank
банк`;

/** Request body for the meaning of one word in its sentence. */
export function buildWordRequest(model: string, sentence: string, word: string, withThinkFlag = true): OllamaChatRequest {
  const request: OllamaChatRequest = {
    model,
    stream: false,
    keep_alive: '20m',
    messages: [
      { role: 'system', content: WORD_SYSTEM_PROMPT },
      { role: 'user', content: `Предложение: ${sentence}\nСлово: ${word}` },
    ],
    options: { ...BASE_OPTIONS, num_predict: 24 },
  };
  if (withThinkFlag) request.think = false;
  return request;
}

/** Strips reasoning blocks, labels and quotes that small models sometimes add around the answer. */
export function cleanModelOutput(raw: string): string {
  let text = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<think>[\s\S]*$/i, '');
  text = text.replace(/\r/g, '').trim();
  text = text.replace(/^(?:перевод|русский перевод|translation|übersetzung)\s*[:：]\s*/i, '');
  // Keep the first paragraph only: explanations, if any, follow after a blank line.
  text = (text.split(/\n\s*\n/)[0] ?? '').replace(/\s*\n\s*/g, ' ').trim();
  const quoted = /^(["«“„'])([\s\S]*)(["»”“'])$/.exec(text);
  if (quoted && quoted[2] !== undefined && !/["«»“”„]/.test(quoted[2])) text = quoted[2].trim();
  return text;
}

/** True when the text plausibly is a Russian translation (guards against echoes and refusals). */
export function looksRussian(text: string): boolean {
  const letters = text.match(/\p{L}/gu) ?? [];
  if (letters.length === 0) return text.trim().length > 0;
  const cyrillic = letters.filter((ch) => /\p{Script=Cyrillic}/u.test(ch)).length;
  return cyrillic / letters.length >= 0.5;
}

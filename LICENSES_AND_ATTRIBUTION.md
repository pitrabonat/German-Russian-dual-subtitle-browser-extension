# Лицензии и авторство

В расширении три вида содержимого с разными лицензиями: код, модель перевода, словарь. Сборка с моделью распространяет все три.

## Код

Код этого репозитория (`src/`, `tests/`, `tools/`, `data-pipeline/`, `local-service/`, `build.mjs`) — лицензия MIT, текст в [LICENSE](LICENSE).

## Модель перевода

**Helsinki-NLP/opus-mt-tc-big-de-zle** — Language Technology Research Group, University of Helsinki (OPUS-MT, Jörg Tiedemann и коллеги), выпуск 2022-03-23. Лицензия [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Карточка модели: https://huggingface.co/Helsinki-NLP/opus-mt-tc-big-de-zle

Что изменено в Mitlesen (CC BY 4.0 требует это указать):

- браузерная версия (`models/browser/…`, в сборке `dist/models/…`): экспорт в ONNX и динамическое квантование весов в int8 (`tools/model/export_onnx.py`), добавлен `tokenizer.json`, построенный из `vocab.json` и SentencePiece-модели; веса не дообучались;
- локальный сервис скачивает конвертацию в CTranslate2 int8 **NothingSoftware/opus-mt-tc-big-de-zle-ct2-int8** (https://huggingface.co/NothingSoftware/opus-mt-tc-big-de-zle-ct2-int8), лицензия CC BY 4.0, тоже без дообучения.

Ссылки для цитирования из карточки модели:

- Tiedemann J., Thottingal S. *OPUS-MT — Building open translation services for the World.* EAMT 2020.
- Tiedemann J. et al. *Democratizing neural machine translation with OPUS-MT.* Language Resources and Evaluation, 2023.

## Словарь

`data/dict` собран скриптом `data-pipeline/build-dict.mjs` из:

| Источник | Лицензия | Что взято |
|---|---|---|
| Английский Викисловарь, немецкие статьи, через kaikki.org (Wiktextract, Tatu Ylonen) | CC BY-SA 4.0 / GFDL | таблицы словоизменения, род, мн. число, формы глагола |
| Русский Викисловарь, немецкие статьи, через kaikki.org | CC BY-SA 4.0 / GFDL | русские значения, переведённые примеры |
| Немецкий Викисловарь через kaikki.org | CC BY-SA 4.0 / GFDL | русские переводы по значениям, немецкие определения, синонимы, недостающие формы |
| FrequencyWords `de_50k` (Hermit Dave, по корпусу OpenSubtitles 2018) | CC BY-SA 4.0 | только частоты для порядка статей и выбора значения |

Ссылки: https://kaikki.org, https://github.com/tatuylonen/wiktextract, https://github.com/hermitdave/FrequencyWords, https://www.wiktionary.org

Словарь — переработка этих материалов (объединение трёх редакций, отбор и упорядочивание значений, сжатие в шарды), поэтому файлы `data/dict` распространяются под **CC BY-SA 4.0**. Если вы используете их отдельно от расширения, сохраняйте ту же лицензию и указание источников. Код расширения при этом остаётся под MIT: словарь — отдельные файлы данных, которые код читает.

## Библиотеки в сборке

| Библиотека | Лицензия |
|---|---|
| @huggingface/transformers (transformers.js) 4.3.2 | Apache 2.0 |
| onnxruntime-web 1.31.0-dev (файлы `ort-wasm-simd-threaded.asyncify.*`) | MIT |

## Инструменты разработки и локальный сервис

Эти пакеты в расширение не входят, но нужны для сборки, тестов или локального режима.

| Пакет | Лицензия |
|---|---|
| TypeScript | Apache 2.0 |
| esbuild | MIT |
| Vitest | MIT |
| fake-indexeddb | Apache 2.0 |
| puppeteer-core | Apache 2.0 |
| CTranslate2 | MIT |
| SentencePiece | Apache 2.0 |
| spaCy | MIT |
| spaCy `de_core_news_md` / `de_core_news_sm` | MIT (данные обучения — см. карточку модели spaCy) |
| optimum, transformers, onnx, onnxruntime, PyTorch (только экспорт модели) | Apache 2.0 / MIT / BSD |
| Ollama | MIT |
| Qwen3-4B-Instruct (`qwen3:4b-instruct` в Ollama) | Apache 2.0 |

Иконки расширения нарисованы скриптом `tools/make-icons.mjs` и входят в код под MIT.

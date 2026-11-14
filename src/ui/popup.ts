// Extension popup: settings, page status, connection checks and diagnostics.
import type { PageRequest, PageState, RuntimeRequest, RuntimeResponse } from '../shared/messages';
import { DEFAULT_SETTINGS, LIMITS, isLoopback, loadSettings, normalizeEndpoint, onSettingsChanged, updateSettings, type Appearance, type Settings } from '../shared/settings.ts';
import type { Diagnostics, ProviderId, ProviderStatus } from '../shared/types';

declare const __VERSION__: string;

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const input = (id: string): HTMLInputElement => $<HTMLInputElement>(id);

let settings: Settings = DEFAULT_SETTINGS;
let tabId: number | undefined;
let tabUrl: URL | null = null;

function send(message: RuntimeRequest): Promise<RuntimeResponse> {
  return chrome.runtime.sendMessage(message).catch((e: unknown) => ({ ok: false as const, error: { code: 'internal' as const, message: String(e) } }));
}

// ── status lines ──

type Tone = 'ok' | 'warn' | 'bad' | 'busy' | '';

function setStatus(container: HTMLElement, tone: Tone, text: string): void {
  const dot = container.querySelector('.dot');
  const label = container.querySelector('span');
  if (dot) dot.className = `dot ${tone}`.trim();
  if (label) label.textContent = text;
}

function providerLine(status: ProviderStatus | undefined): [Tone, string] {
  if (!status) return ['', 'не проверялось'];
  switch (status.state) {
    case 'ready':
      return ['ok', status.detail ? `Готов: ${status.detail}` : 'Готов'];
    case 'loading':
      return ['busy', `${status.detail ?? 'Загрузка'}${status.progress !== undefined ? ` ${Math.round(status.progress * 100)}%` : ''}…`];
    case 'unavailable':
      return ['warn', status.error?.message ?? 'Недоступен'];
    case 'error':
      return ['bad', status.error?.message ?? 'Ошибка'];
    default:
      return ['', 'не проверялось'];
  }
}

// ── settings form ──

const TOGGLES = ['enabled', 'showGerman', 'showRussian', 'wordPopup', 'pauseOnHover', 'mergeFragments', 'ollamaFullGpu'] as const;
const LOOK_SLIDERS = ['fontScale', 'ruScale', 'position', 'lineGap', 'bgOpacity'] as const;
const OTHER_SLIDERS = ['contextSize', 'preloadAhead'] as const;

const FORMAT: Record<string, (v: number) => string> = {
  fontScale: (v) => `${v.toFixed(1)}%`,
  ruScale: (v) => `${Math.round(v * 100)}%`,
  position: (v) => `${Math.round(v)}%`,
  lineGap: (v) => `${Math.round(v)}%`,
  bgOpacity: (v) => `${Math.round(v * 100)}%`,
  contextSize: (v) => String(v),
  preloadAhead: (v) => String(v),
};

function paintSlider(el: HTMLInputElement): void {
  const min = Number(el.min);
  const max = Number(el.max);
  el.style.setProperty('--fill', `${((Number(el.value) - min) / (max - min)) * 100}%`);
  const out = document.querySelector<HTMLOutputElement>(`output[for="${el.id}"]`);
  if (out) out.textContent = FORMAT[el.id]?.(Number(el.value)) ?? el.value;
}

function paintPreview(a: Appearance): void {
  const s = $('preview').style;
  s.setProperty('--pv-fs', `${(a.fontScale * 4.2).toFixed(1)}px`);
  s.setProperty('--pv-ru-scale', String(a.ruScale));
  s.setProperty('--pv-gap', String(a.lineGap / 100));
  s.setProperty('--pv-bg', String(a.bgOpacity));
  s.setProperty('--pv-de', a.deColor);
  s.setProperty('--pv-ru', a.ruColor);
  s.setProperty('--pv-bottom', `${Math.min(55, a.position)}%`);
  document.querySelector<HTMLElement>('.pv-de')!.hidden = !settings.showGerman;
  document.querySelector<HTMLElement>('.pv-ru')!.hidden = !settings.showRussian;
}

function render(): void {
  for (const id of TOGGLES) input(id).checked = settings[id];
  for (const id of LOOK_SLIDERS) {
    const el = input(id);
    if (document.activeElement !== el) el.value = String(settings.appearance[id]);
    paintSlider(el);
  }
  for (const id of OTHER_SLIDERS) {
    const el = input(id);
    if (document.activeElement !== el) el.value = String(settings[id]);
    paintSlider(el);
  }
  input('deColor').value = settings.appearance.deColor;
  input('ruColor').value = settings.appearance.ruColor;
  for (const radio of Array.from(document.querySelectorAll<HTMLInputElement>('input[name="mode"]'))) radio.checked = radio.value === settings.mode;
  $<HTMLSelectElement>('localProvider').value = settings.localProvider;
  for (const id of ['ollamaEndpoint', 'ollamaModel', 'serviceEndpoint'] as const) {
    const el = input(id);
    if (document.activeElement !== el) el.value = settings[id];
  }
  const local = settings.mode === 'local';
  $('localBox').hidden = !local;
  $('browserStatus').hidden = local;
  $('ollamaBox').hidden = settings.localProvider !== 'ollama';
  $('serviceBox').hidden = false;
  $('modeHint').textContent = local
    ? 'Перевод делает программа на этом компьютере. Если она не отвечает, расширение само переходит на модель в браузере.'
    : 'Модель перевода работает внутри расширения. Ничего устанавливать не нужно, текст никуда не отправляется.';
  $('main').classList.toggle('off', !settings.enabled);
  paintPreview(settings.appearance);
}

function bindSettings(): void {
  for (const id of TOGGLES) {
    input(id).addEventListener('change', (e) => void updateSettings({ [id]: (e.target as HTMLInputElement).checked }));
  }
  for (const id of LOOK_SLIDERS) {
    const el = input(id);
    const [min, max] = LIMITS[id];
    el.min = String(min);
    el.max = String(max);
    el.addEventListener('input', () => {
      paintSlider(el);
      settings = { ...settings, appearance: { ...settings.appearance, [id]: Number(el.value) } };
      paintPreview(settings.appearance);
      void updateSettings({ appearance: { [id]: Number(el.value) } });
    });
  }
  for (const id of OTHER_SLIDERS) {
    const el = input(id);
    const [min, max] = LIMITS[id];
    el.min = String(min);
    el.max = String(max);
    el.addEventListener('input', () => {
      paintSlider(el);
      void updateSettings({ [id]: Number(el.value) });
    });
  }
  for (const id of ['deColor', 'ruColor'] as const) {
    input(id).addEventListener('input', (e) => void updateSettings({ appearance: { [id]: (e.target as HTMLInputElement).value } }));
  }
  $('resetLook').addEventListener('click', () => void updateSettings({ appearance: DEFAULT_SETTINGS.appearance }));
  for (const radio of Array.from(document.querySelectorAll<HTMLInputElement>('input[name="mode"]'))) {
    radio.addEventListener('change', () => {
      if (radio.checked) void updateSettings({ mode: radio.value as Settings['mode'] }).then(() => refreshDiagnostics());
    });
  }
  $<HTMLSelectElement>('localProvider').addEventListener('change', (e) => void updateSettings({ localProvider: (e.target as HTMLSelectElement).value as Settings['localProvider'] }));
  input('ollamaModel').addEventListener('change', (e) => void updateSettings({ ollamaModel: (e.target as HTMLInputElement).value }));
  for (const id of ['ollamaEndpoint', 'serviceEndpoint'] as const) {
    input(id).addEventListener('change', (e) => {
      const el = e.target as HTMLInputElement;
      el.value = normalizeEndpoint(el.value, DEFAULT_SETTINGS[id]);
      void updateSettings({ [id]: el.value });
    });
  }
}

// ── local service checks ──

async function checkProvider(provider: ProviderId, endpoint: string, line: HTMLElement, button: HTMLButtonElement): Promise<void> {
  button.disabled = true;
  setStatus(line, 'busy', 'Проверяю…');
  try {
    // Addresses outside this computer need the user's explicit permission.
    if (!isLoopback(endpoint)) {
      const granted = await chrome.permissions.request({ origins: [`${endpoint}/*`] });
      if (!granted) {
        setStatus(line, 'bad', 'Нет разрешения на доступ к этому адресу.');
        return;
      }
    }
    const response = await send({ t: 'check-provider', provider });
    if (response.ok) setStatus(line, ...providerLine(response.status));
    else setStatus(line, 'bad', response.error.message);
  } finally {
    button.disabled = false;
  }
}

// ── page status ──

const PAGE_TEXT: Record<PageState['status']['code'], [Tone, string]> = {
  searching: ['busy', 'Ищу видео и субтитры…'],
  ready: ['ok', 'Немецкие субтитры найдены'],
  'no-video': ['', 'На этой странице нет видео'],
  'no-subtitles': ['warn', 'У видео нет субтитров'],
  'no-german': ['warn', 'Немецкой дорожки нет'],
  'waiting-captions': ['busy', 'Жду субтитры от плеера…'],
  blocked: ['bad', 'Текст субтитров недоступен'],
};

function showPage(state: PageState | null): void {
  const hint = $('pageHint');
  const trackField = $('trackField');
  hint.hidden = true;
  trackField.hidden = true;
  if (!state) {
    const web = tabUrl !== null && /^https?:$/.test(tabUrl.protocol);
    setStatus($('page'), '', web ? 'На этой странице нет видео' : 'На этой странице расширение не работает');
    hint.hidden = false;
    hint.textContent = web
      ? 'Если видео есть, а страница была открыта до установки расширения, обновите её.'
      : 'Служебные страницы браузера и магазин расширений закрыты для всех расширений.';
    return;
  }
  const [tone, text] = PAGE_TEXT[state.status.code];
  setStatus($('page'), tone, state.status.code === 'ready' && state.cueCount > 0 ? `${text}: ${state.cueCount} реплик` : text);
  if (state.status.detail) {
    hint.hidden = false;
    hint.textContent = state.status.code === 'ready' || state.status.code === 'waiting-captions' ? `Дорожка: ${state.status.detail}` : state.status.detail;
  }
  if (state.tracks.length > 1) {
    const select = $<HTMLSelectElement>('track');
    select.replaceChildren(
      ...state.tracks.map((t) => {
        const option = document.createElement('option');
        option.value = t.id;
        option.textContent = `${t.label}${t.kind === 'asr' ? ' (автоматические)' : ''}`;
        option.selected = t.id === state.activeTrackId;
        return option;
      }),
    );
    trackField.hidden = false;
  }
}

async function askPage(message: PageRequest): Promise<PageState | null> {
  if (tabId === undefined) return null;
  try {
    return ((await chrome.tabs.sendMessage(tabId, message)) as PageState | undefined) ?? null;
  } catch {
    return null; // no content script in this tab
  }
}

async function refreshPage(): Promise<void> {
  showPage(await askPage({ t: 'page-state' }));
}

// ── diagnostics ──

const PROVIDER_NAME: Record<ProviderId, string> = { 'opus-browser': 'OPUS-MT в браузере', 'local-service': 'Сервис Mitlesen', ollama: 'Ollama' };

function row(...cells: (string | Node)[]): HTMLTableRowElement {
  const tr = document.createElement('tr');
  for (const cell of cells) {
    const td = document.createElement('td');
    td.append(cell);
    tr.append(td);
  }
  return tr;
}

function showDiagnostics(d: Diagnostics): void {
  const byId = new Map(d.providers.map((p) => [p.id, p]));
  setStatus($('browserStatus'), ...providerLine(byId.get('opus-browser')));
  if (settings.mode === 'local') {
    setStatus($('ollamaStatus'), ...providerLine(byId.get('ollama')));
    setStatus($('serviceStatus'), ...providerLine(byId.get('local-service')));
  }
  const pairs: [string, string][] = [
    ['Сейчас переводит', d.activeProvider ? PROVIDER_NAME[d.activeProvider] : 'никто (нет доступного провайдера)'],
    ['Грамматика', d.analysisEngine === 'spacy' ? 'словарь + разбор spaCy' : 'словарь и правила в браузере'],
    ['Разбор фразы', d.analysisLatency.count > 0 ? `${d.analysisLatency.median} мс (медиана), ${d.analysisLatency.p95} мс (p95)` : 'ещё не замерялся'],
    ['Словарь', d.dictionary ? `${d.dictionary.entries.toLocaleString('ru')} слов, сборка ${d.dictionary.version}` : 'не найден'],
    ['Кэш', `${d.cache.translations.toLocaleString('ru')} переводов, ${d.cache.analyses.toLocaleString('ru')} разборов, ≈ ${(d.cache.approxBytes / 1048576).toFixed(1)} МБ`],
    ['Очередь', `${d.queue.waiting} ждут, ${d.queue.inFlight} в работе`],
    ['Версия', `${d.version}, offscreen API: ${d.offscreenApi ? 'есть' : 'нет'}`],
  ];
  const kv = $('diagSummary');
  kv.replaceChildren();
  for (const [k, v] of pairs) {
    const key = document.createElement('span');
    key.className = 'k';
    key.textContent = k;
    const value = document.createElement('span');
    value.className = 'v';
    value.textContent = v;
    kv.append(key, value);
  }
  const body = $('diagProviders').querySelector('tbody')!;
  body.replaceChildren();
  for (const m of d.metrics) {
    const name = document.createElement('span');
    name.textContent = PROVIDER_NAME[m.id];
    if (m.initMs !== undefined) {
      const small = document.createElement('small');
      small.textContent = ` запуск ${(m.initMs / 1000).toFixed(1)} с`;
      name.append(small);
    }
    body.append(row(name, `${m.requests}${m.errors ? ` (${m.errors} ош.)` : ''}`, `${m.latency.avg} мс`, `${m.latency.median} мс`, `${m.latency.p95} мс`));
  }
  if (d.metrics.length === 0) body.append(row('Пока нет замеров', '', '', '', ''));
  const error = $('diagError');
  error.hidden = !d.lastError;
  if (d.lastError) error.textContent = `Последняя ошибка (${new Date(d.lastError.at).toLocaleTimeString('ru')}): ${d.lastError.message}`;
}

async function refreshDiagnostics(): Promise<void> {
  const response = await send({ t: 'diagnostics' });
  if (response.ok && response.diagnostics) showDiagnostics(response.diagnostics);
}

// ── start ──

async function main(): Promise<void> {
  $('version').textContent = `версия ${__VERSION__}`;
  settings = await loadSettings();
  bindSettings();
  render();
  onSettingsChanged((next) => {
    settings = next;
    render();
  });

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id;
  try {
    tabUrl = tab?.url ? new URL(tab.url) : null;
  } catch {
    tabUrl = null;
  }

  $<HTMLSelectElement>('track').addEventListener('change', (e) => {
    void askPage({ t: 'select-track', id: (e.target as HTMLSelectElement).value }).then(() => setTimeout(() => void refreshPage(), 900));
  });
  $('checkOllama').addEventListener('click', (e) => void checkProvider('ollama', settings.ollamaEndpoint, $('ollamaStatus'), e.currentTarget as HTMLButtonElement));
  $('checkService').addEventListener('click', (e) => void checkProvider('local-service', settings.serviceEndpoint, $('serviceStatus'), e.currentTarget as HTMLButtonElement));
  $('clearCache').addEventListener('click', () => {
    void send({ t: 'clear-cache' }).then(() => {
      $('cacheNote').textContent = 'Кэш очищен.';
      void refreshDiagnostics();
    });
  });
  $<HTMLDetailsElement>('diag').addEventListener('toggle', () => void refreshDiagnostics());

  void refreshPage();
  void refreshDiagnostics();
  // The page status changes while the popup is open (tracks load, captions arrive).
  const timer = setInterval(() => void refreshPage(), 1500);
  window.addEventListener('unload', () => clearInterval(timer));
}

void main();

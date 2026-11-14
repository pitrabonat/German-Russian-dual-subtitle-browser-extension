// Subtitle overlay: two text lines over the video plus the word panel.
// Rendering only. What to show and when is decided by the controller.
import type { Settings } from '../../shared/settings';
import { clamp } from '../../shared/text.ts';
import type { Token, WordAnalysis } from '../../shared/types';
import type { OverlayMount } from '../adapters/types';
import { OVERLAY_CSS } from './styles.ts';
import { buildPopupView, type PopupView } from './wordView.ts';

export interface CueView {
  unitIndex: number;
  text: string;
  tokens: Token[];
  /** Index of the first token of this cue within its translation unit. */
  tokenOffset: number;
}

export type RussianView = { kind: 'text'; text: string; late: boolean } | { kind: 'pending' } | { kind: 'none' };

export interface OverlayHost {
  /** Analysis of a word; 'pending' while it is being computed; null when there is none. */
  word(unitIndex: number, tokenIndex: number): WordAnalysis | 'pending' | null;
  /** A word panel was opened for this word; the host may fetch more detail. */
  wordOpened(unitIndex: number, tokenIndex: number): void;
  panelOpened(): void;
  panelClosed(): void;
}

const OPEN_DELAY_MS = 90;
const CLOSE_DELAY_MS = 180;
/** Hovering a neighbouring word this soon after a panel closed opens the next one instantly. */
const INSTANT_WINDOW_MS = 350;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export class Overlay {
  private readonly host = el('div');
  private readonly stage = el('div', 'stage');
  private readonly block = el('div', 'block');
  private readonly deLine = el('p', 'line de');
  private readonly deBg = el('span', 'bg');
  private readonly ruLine = el('p', 'line ru');
  private readonly ruBg = el('span', 'bg');
  private readonly chip = el('div', 'chip');
  private readonly pop = el('div', 'pop');

  private mountInfo: OverlayMount | null = null;
  private settings: Settings | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private inset = 0;
  private cue: CueView | null = null;
  private chipTimer: ReturnType<typeof setTimeout> | undefined;
  private native: NativeCues | null = null;
  private russianText = '';

  private panel = { open: false, pinned: false, unitIndex: -1, tokenIndex: -1, span: null as HTMLElement | null, closedAt: 0 };
  private openTimer: ReturnType<typeof setTimeout> | undefined;
  private closeTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly owner: OverlayHost) {
    this.host.id = 'mitlesen-overlay';
    const root = this.host.attachShadow({ mode: 'open' });
    const style = el('style');
    style.textContent = OVERLAY_CSS;
    this.deLine.lang = 'de';
    this.ruLine.lang = 'ru';
    this.deLine.append(this.deBg);
    this.ruLine.append(this.ruBg);
    this.block.append(this.deLine, this.ruLine);
    this.pop.setAttribute('role', 'tooltip');
    this.stage.append(this.block, this.chip, this.pop);
    root.append(style, this.stage);
    this.deLine.hidden = true;
    this.ruLine.hidden = true;
    this.bindEvents();
  }

  // ── mounting and geometry ──

  mount(mount: OverlayMount): void {
    this.unmount();
    this.mountInfo = mount;
    this.native = new NativeCues(mount.video);
    this.place();
    this.resizeObserver = new ResizeObserver(() => this.layout());
    this.resizeObserver.observe(mount.video);
    this.resizeObserver.observe(this.host);
    document.addEventListener('fullscreenchange', this.onFullscreenChange);
    if (mount.mode === 'fixed') {
      window.addEventListener('scroll', this.syncRect, { capture: true, passive: true });
      window.addEventListener('resize', this.syncRect, { passive: true });
    }
    document.addEventListener('pointerdown', this.onDocumentPointerDown, true);
    document.addEventListener('keydown', this.onKeyDown, true);
    this.layout();
  }

  unmount(): void {
    this.closePanel();
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    document.removeEventListener('fullscreenchange', this.onFullscreenChange);
    window.removeEventListener('scroll', this.syncRect, { capture: true });
    window.removeEventListener('resize', this.syncRect);
    document.removeEventListener('pointerdown', this.onDocumentPointerDown, true);
    document.removeEventListener('keydown', this.onKeyDown, true);
    this.native?.clear();
    this.native = null;
    this.host.remove();
    this.mountInfo = null;
  }

  /** Puts the host element where it will be visible: inside the player, or over the video rectangle. */
  private place(): void {
    const mount = this.mountInfo;
    if (!mount) return;
    const fullscreen = document.fullscreenElement;
    if (mount.mode === 'inside') {
      this.host.style.cssText = 'position:absolute;inset:0;z-index:61;pointer-events:none;';
      if (this.host.parentElement !== mount.container) mount.container.append(this.host);
    } else {
      this.host.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483000;pointer-events:none;';
      // In fullscreen only descendants of the fullscreen element are painted.
      const parent = fullscreen instanceof HTMLElement && fullscreen !== mount.video && fullscreen.contains(mount.video) ? fullscreen : document.documentElement;
      if (this.host.parentElement !== parent) parent.append(this.host);
      this.syncRect();
    }
    // When the <video> element itself is fullscreen nothing else can be drawn: use native cues.
    this.native?.setActive(fullscreen === mount.video);
    this.updateNative();
  }

  private readonly onFullscreenChange = (): void => {
    this.place();
    this.layout();
  };

  /** Keeps the fixed-position host on top of the video rectangle. */
  readonly syncRect = (): void => {
    const mount = this.mountInfo;
    if (!mount || mount.mode !== 'fixed') return;
    const r = mount.video.getBoundingClientRect();
    const s = this.host.style;
    s.left = `${r.left}px`;
    s.top = `${r.top}px`;
    s.width = `${r.width}px`;
    s.height = `${r.height}px`;
  };

  private layout(): void {
    if (!this.mountInfo || !this.settings) return;
    this.syncRect();
    const height = this.host.getBoundingClientRect().height;
    if (height <= 0) return;
    const a = this.settings.appearance;
    this.stage.style.setProperty('--fs', `${clamp((height * a.fontScale) / 100, 12, 76).toFixed(1)}px`);
    // Lift the block above the player controls when they would cover it.
    const bottomPx = (height * a.position) / 100;
    this.stage.style.setProperty('--lift', `${Math.max(0, this.inset + 6 - bottomPx).toFixed(0)}px`);
    if (this.panel.open && this.panel.span) this.positionPanel(this.panel.span);
  }

  setBottomInset(pixels: number): void {
    this.inset = pixels;
    this.layout();
  }

  applySettings(settings: Settings): void {
    this.settings = settings;
    const a = settings.appearance;
    const s = this.stage.style;
    s.setProperty('--de', a.deColor);
    s.setProperty('--ru', a.ruColor);
    s.setProperty('--bg', String(a.bgOpacity));
    s.setProperty('--gap', String(a.lineGap / 100));
    s.setProperty('--ru-scale', String(a.ruScale));
    s.setProperty('--bottom', `${a.position}%`);
    this.stage.hidden = !settings.enabled;
    if (!settings.wordPopup) this.closePanel();
    // Re-render so that words become (non-)interactive and line visibility follows the settings.
    const cue = this.cue;
    this.cue = null;
    this.showCue(cue);
    this.ruLine.hidden = !settings.showRussian || this.ruBg.textContent === '';
    this.layout();
  }

  setVisible(visible: boolean): void {
    this.stage.hidden = !visible || !(this.settings?.enabled ?? true);
    if (!visible) {
      this.closePanel();
      this.native?.show('', '');
    } else {
      this.updateNative();
    }
  }

  // ── subtitle lines ──

  showCue(cue: CueView | null): void {
    if (cue && this.cue && cue.unitIndex === this.cue.unitIndex && cue.text === this.cue.text && cue.tokenOffset === this.cue.tokenOffset) return;
    this.closePanel();
    this.cue = cue;
    const interactive = this.settings?.wordPopup ?? true;
    const nodes: (Node | string)[] = [];
    if (cue) {
      cue.tokens.forEach((token, i) => {
        if (i > 0 && token.spaceBefore) nodes.push(' ');
        if (token.kind === 'word' && interactive) {
          const span = el('span', 'w', token.text);
          span.dataset.i = String(cue.tokenOffset + i);
          nodes.push(span);
        } else {
          nodes.push(token.text);
        }
      });
    }
    this.deBg.replaceChildren(...nodes);
    this.deLine.hidden = !cue || !(this.settings?.showGerman ?? true);
    this.syncRect();
    this.updateNative();
  }

  setRussian(view: RussianView): void {
    const show = this.settings?.showRussian ?? true;
    this.ruLine.classList.remove('pending', 'late');
    if (view.kind === 'none') {
      this.ruBg.textContent = '';
      this.russianText = '';
      this.ruLine.hidden = true;
    } else if (view.kind === 'pending') {
      this.ruBg.textContent = '···';
      this.russianText = '';
      this.ruLine.classList.add('pending');
      this.ruLine.hidden = !show;
    } else {
      this.ruBg.textContent = view.text;
      this.russianText = view.text;
      this.ruLine.hidden = !show;
      if (view.late) {
        void this.ruLine.offsetWidth; // restart the fade for a translation that arrives late
        this.ruLine.classList.add('late');
      }
    }
    this.updateNative();
  }

  private updateNative(): void {
    if (!this.native) return;
    const s = this.settings;
    const de = this.cue && (s?.showGerman ?? true) ? this.cue.text : '';
    const ru = (s?.showRussian ?? true) ? this.russianText : '';
    this.native.show(de, ru);
  }

  /** Small note in the corner of the video. `null` hides it. */
  setStatus(text: string | null, kind: 'info' | 'error' = 'info', holdMs = 5000): void {
    clearTimeout(this.chipTimer);
    if (!text) {
      this.chip.classList.remove('show');
      return;
    }
    const title = el('b', undefined, 'Mitlesen');
    this.chip.replaceChildren(title, ` · ${text}`);
    this.chip.classList.toggle('error', kind === 'error');
    this.chip.classList.add('show');
    if (holdMs > 0) this.chipTimer = setTimeout(() => this.chip.classList.remove('show'), holdMs);
  }

  // ── word panel ──

  private bindEvents(): void {
    const wordOf = (target: EventTarget | null): HTMLElement | null => (target instanceof HTMLElement && target.classList.contains('w') ? target : null);

    this.block.addEventListener('pointerover', (e) => {
      const span = wordOf(e.target);
      if (!span || e.pointerType === 'touch' || this.panel.pinned) return;
      clearTimeout(this.closeTimer);
      if (this.panel.open && this.panel.span === span) return;
      clearTimeout(this.openTimer);
      const instant = this.panel.open || performance.now() - this.panel.closedAt < INSTANT_WINDOW_MS;
      this.openTimer = setTimeout(() => this.openPanel(span, instant), instant ? 0 : OPEN_DELAY_MS);
    });
    this.block.addEventListener('pointerout', (e) => {
      if (!wordOf(e.target) || this.panel.pinned) return;
      clearTimeout(this.openTimer);
      this.scheduleClose();
    });
    this.pop.addEventListener('pointerenter', () => clearTimeout(this.closeTimer));
    this.pop.addEventListener('pointerleave', () => {
      if (!this.panel.pinned) this.scheduleClose();
    });

    // Click or tap pins the panel; this is also the touch interaction, where hover does not exist.
    this.block.addEventListener('click', (e) => {
      const span = wordOf(e.target);
      if (!span) return;
      clearTimeout(this.openTimer);
      clearTimeout(this.closeTimer);
      if (this.panel.open && this.panel.pinned && this.panel.span === span) {
        this.closePanel();
        return;
      }
      this.openPanel(span, this.panel.open);
      this.panel.pinned = true;
    });

    // Words and the panel must not trigger the player underneath (play/pause, fullscreen, seek).
    const swallow = (e: Event): void => {
      const path = e.composedPath();
      if (path.includes(this.pop) || path.some((n) => n instanceof HTMLElement && n.classList.contains('w'))) e.stopPropagation();
    };
    for (const type of ['click', 'dblclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart', 'touchend', 'contextmenu', 'wheel']) {
      this.stage.addEventListener(type, swallow);
    }
  }

  private readonly onDocumentPointerDown = (e: Event): void => {
    if (this.panel.open && this.panel.pinned && !e.composedPath().includes(this.host)) this.closePanel();
  };

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && this.panel.open) this.closePanel();
  };

  private scheduleClose(): void {
    clearTimeout(this.closeTimer);
    this.closeTimer = setTimeout(() => this.closePanel(), CLOSE_DELAY_MS);
  }

  private openPanel(span: HTMLElement, instant: boolean): void {
    const cue = this.cue;
    const tokenIndex = Number(span.dataset.i);
    if (!cue || !Number.isInteger(tokenIndex) || !span.isConnected) return;
    const wasOpen = this.panel.open;
    this.panel.span?.classList.remove('on');
    this.panel = { ...this.panel, open: true, pinned: false, unitIndex: cue.unitIndex, tokenIndex, span };
    span.classList.add('on');
    this.renderPanel();
    this.pop.classList.toggle('instant', instant);
    this.pop.classList.add('open');
    if (!wasOpen) this.owner.panelOpened();
    this.owner.wordOpened(cue.unitIndex, tokenIndex);
  }

  closePanel(): void {
    clearTimeout(this.openTimer);
    clearTimeout(this.closeTimer);
    if (!this.panel.open) return;
    this.panel.span?.classList.remove('on');
    for (const linked of Array.from(this.deBg.querySelectorAll('.linked'))) linked.classList.remove('linked');
    this.panel = { open: false, pinned: false, unitIndex: -1, tokenIndex: -1, span: null, closedAt: performance.now() };
    this.pop.classList.remove('open', 'instant');
    this.owner.panelClosed();
  }

  /** Call when the analysis of a unit arrived or changed; refreshes an open panel of that unit. */
  refreshUnit(unitIndex: number): void {
    if (this.panel.open && this.panel.unitIndex === unitIndex) this.renderPanel();
  }

  private renderPanel(): void {
    const { unitIndex, tokenIndex, span } = this.panel;
    if (!span) return;
    const analysis = this.owner.word(unitIndex, tokenIndex);
    for (const linked of Array.from(this.deBg.querySelectorAll('.linked'))) linked.classList.remove('linked');

    if (analysis === 'pending' || analysis === null) {
      this.pop.replaceChildren(
        el('div', 'head').appendChild(el('div', 'title', span.textContent ?? '')).parentElement as HTMLElement,
        el('div', 'tr wait', analysis === 'pending' ? 'Разбираю слово…' : 'Нет данных об этом слове.'),
      );
    } else {
      this.pop.replaceChildren(...this.panelNodes(buildPopupView(analysis)));
      // Show the other half of a separable verb.
      if (analysis.kind === 'verb' && analysis.separable?.separated) {
        const partner = tokenIndex === analysis.separable.prefixTokenIndex ? analysis.separable.verbTokenIndex : analysis.separable.prefixTokenIndex;
        if (partner !== undefined) this.deBg.querySelector<HTMLElement>(`.w[data-i="${partner}"]`)?.classList.add('linked');
      }
    }
    this.positionPanel(span);
  }

  private panelNodes(view: PopupView): HTMLElement[] {
    const nodes: HTMLElement[] = [];
    const head = el('div', 'head');
    const title = el('div', 'title');
    if (view.article) title.append(el('span', `art ${view.article.cls}`, view.article.text), ' ');
    title.append(view.title);
    const tags = el('div', 'tags');
    for (const tag of view.tags) tags.append(el('span', 'tag', tag));
    head.append(title, tags);
    nodes.push(head);

    const mark = (): HTMLElement => {
      const q = el('span', 'q', '?');
      q.title = 'Определено неточно';
      return q;
    };

    if (view.translation) {
      const tr = el('div', 'tr', view.translation.text);
      if (view.translation.uncertain) tr.append(mark());
      if (view.translation.source === 'llm') tr.append(el('span', 'src', 'по контексту'));
      else if (view.translation.source === 'mt') tr.append(el('span', 'src', 'машинный перевод'));
      nodes.push(tr);
    } else {
      nodes.push(el('div', 'tr wait', 'Перевода в словаре нет.'));
      if (view.definition) {
        const definition = el('div', 'more');
        definition.append(el('span', 'lbl', 'По-немецки: '), view.definition);
        nodes.push(definition);
      }
    }

    if (view.rows.length > 0) {
      const dl = el('dl', 'rows');
      for (const row of view.rows) {
        const dd = el('dd', undefined, row.value);
        if (row.uncertain) dd.append(mark());
        dl.append(el('dt', undefined, row.label), dd);
      }
      nodes.push(dl);
    }

    if (view.conjugation) {
      const conj = el('div', 'conj');
      conj.append(el('div', 'lbl', 'Präsens'));
      for (const [pronoun, form] of view.conjugation) {
        const cell = el('div');
        cell.append(el('i', undefined, `${pronoun} `), form ?? '');
        conj.append(cell);
      }
      nodes.push(conj);
    }

    const extra = (label: string, text: string): void => {
      const more = el('div', 'more');
      more.append(el('span', 'lbl', `${label} `), text);
      nodes.push(more);
    };
    if (view.otherSenses.length > 0) extra('Другие значения:', view.otherSenses.join('; '));
    if (view.alternatives.length > 0) extra('Возможно также:', view.alternatives.join('; '));
    for (const note of view.notes) extra('Примечание:', note);

    if (view.example) {
      const ex = el('div', 'ex', `„${view.example.de}“`);
      if (view.example.ru) ex.append(el('span', 'exru', view.example.ru));
      nodes.push(ex);
    }
    if (view.hasUncertain) nodes.push(el('div', 'foot', '? — определено по правилам и может быть неточным'));
    return nodes;
  }

  private positionPanel(span: HTMLElement): void {
    const stage = this.stage.getBoundingClientRect();
    const word = span.getBoundingClientRect();
    const block = this.block.getBoundingClientRect();
    const width = this.pop.offsetWidth;
    const height = this.pop.offsetHeight;
    const center = word.left + word.width / 2 - stage.left;
    const x = clamp(center - width / 2, 8, Math.max(8, stage.width - width - 8));
    let y = word.top - stage.top - height - 9;
    let below = false;
    if (y < 6) {
      const underBlock = block.bottom - stage.top + 9;
      if (underBlock + height <= stage.height - 6) {
        y = underBlock;
        below = true;
      } else {
        y = 6;
      }
    }
    this.pop.classList.toggle('below', below);
    this.pop.style.setProperty('--x', `${Math.round(x)}px`);
    this.pop.style.setProperty('--y', `${Math.round(y)}px`);
    this.pop.style.setProperty('--ox', `${Math.round(center - x)}px`);
  }
}

/**
 * Fallback for fullscreen on the bare <video> element: both lines are shown as one native cue.
 * Words are not interactive there; the full overlay returns when fullscreen ends.
 */
class NativeCues {
  private static readonly tracks = new WeakMap<HTMLVideoElement, TextTrack>();
  private active = false;
  private cue: VTTCue | null = null;
  private text = '';

  constructor(private readonly video: HTMLVideoElement) {}

  private track(): TextTrack | null {
    let track = NativeCues.tracks.get(this.video) ?? null;
    if (!track) {
      try {
        track = this.video.addTextTrack('subtitles', 'Mitlesen', 'de');
        NativeCues.tracks.set(this.video, track);
      } catch {
        return null;
      }
    }
    return track;
  }

  setActive(active: boolean): void {
    if (active === this.active) return;
    this.active = active;
    if (!active) this.clear();
  }

  show(de: string, ru: string): void {
    const text = [de, ru].filter(Boolean).join('\n');
    this.text = text;
    if (!this.active) return;
    const track = this.track();
    if (!track) return;
    if (this.cue) {
      track.removeCue(this.cue);
      this.cue = null;
    }
    if (text) {
      track.mode = 'showing';
      const now = this.video.currentTime;
      this.cue = new VTTCue(Math.max(0, now - 1), now + 3600, text);
      track.addCue(this.cue);
    }
  }

  clear(): void {
    const track = NativeCues.tracks.get(this.video);
    if (!track) return;
    if (this.cue) {
      try {
        track.removeCue(this.cue);
      } catch {
        /* already gone */
      }
      this.cue = null;
    }
    track.mode = 'disabled';
    void this.text;
  }
}

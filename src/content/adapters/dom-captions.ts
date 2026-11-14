// Reads subtitles that a web player draws as ordinary page text (most custom players do:
// Netflix, Prime Video, Disney+, Max, Vimeo, video.js, JW Player, Shaka, Bitmovin, …).
// There are no timestamps this way, so lines arrive as they appear on screen and cannot be
// translated ahead. Sites with a readable subtitle file get a dedicated adapter instead.
import { normalizeCueText } from '../../shared/text.ts';

/** Containers of the current caption in widely used players. */
export const KNOWN_CAPTION_SELECTORS = [
  '.player-timedtext', // Netflix
  '.atvwebplayersdk-captions-text', // Prime Video
  '[data-testid="CueBoxContainer"]', // Max
  '.dss-subtitle-renderer-cue-window', // Disney+
  '.vjs-text-track-display', // video.js
  '.jw-captions', // JW Player
  '.plyr__captions', // Plyr
  '.shaka-text-container', // Shaka Player
  '.bmpui-ui-subtitle-overlay', // Bitmovin
  '.vp-captions', // Vimeo
  '.theoplayer-texttracks', // THEOplayer
  '.ytp-caption-window-container', // YouTube embeds
];

const CAPTION_HINT = /(caption|subtitle|untertitel|timedtext|text-?track|\bcue)/i;
const MAX_LINE = 400;

// Frequent German words that are rare in English, Dutch, the Scandinavian and Romance languages.
const STRONG_MARKERS = new Set(
  ('ich wir ihr nicht ist und dem ein eine einen einem einer auf für von zu zum zur sich sie nein auch aber noch schon ' +
    'jetzt wo warum mir mich dir dich uns euch sein haben habe hast bist sind seid wird werden kann kannst muss müssen ' +
    'soll sollst gut nur sehr doch gibt geht kommt komm kommen weiß wenn dass oder nach bei aus über kein keine nichts ' +
    'mein meine meinen dein deine deinen alles etwas heute morgen gestern danke bitte wieder immer gerade vielleicht ' +
    'dann denn weil mehr viel beim vom ins ihn ihm ihnen ihre seine diese dieser dieses jeder jede jeden welche ' +
    'zwei drei uhr jahr leute mann frau kinder haus zeit machen macht sagen sagt gehen sehen sieht weiter zurück ' +
    'schnell genau wirklich natürlich eigentlich sicher bis seit ohne durch gegen unter zwischen können möchte schön').split(' '),
);
// German too, but also everyday words elsewhere: "er", "du", "ja" (Scandinavian), "es" (Spanish),
// "das"/"des" (Portuguese, French), "wie"/"hier" (Dutch), "mit"/"der"/"den" (Danish), "im" (English captions).
const WEAK_MARKERS = new Set('er du ja es der das den des mit wie hier mal im um'.split(' '));

export interface GermanScore {
  /** Weighted share of German-looking words (0…1). */
  score: number;
  words: number;
  /** Different unambiguous German words seen. */
  distinct: number;
}

/** How German a piece of text looks. Umlauts and ß alone count half: Finnish, Swedish and Turkish have them too. */
export function germanScore(text: string): GermanScore {
  const words = text.toLowerCase().match(/[a-zäöüß]+/g) ?? [];
  if (words.length === 0) return { score: 0, words: 0, distinct: 0 };
  let hits = 0;
  const strong = new Set<string>();
  for (const w of words) {
    if (STRONG_MARKERS.has(w)) {
      hits += 1;
      strong.add(w);
    } else if (WEAK_MARKERS.has(w) || /[äöüß]/.test(w)) hits += 0.5;
  }
  return { score: hits / words.length, words: words.length, distinct: strong.size };
}

export type LanguageVerdict = 'unknown' | 'german' | 'other';

/**
 * Decides the language of the caption stream from its recent lines, and changes its mind when the
 * viewer switches the subtitle language: German needs the last four lines to look German,
 * "not German" needs the last eight to look clearly foreign.
 */
export class LanguageGate {
  private recent: string[] = [];
  verdict: LanguageVerdict = 'unknown';

  add(line: string): LanguageVerdict {
    this.recent.push(line);
    if (this.recent.length > 8) this.recent.shift();
    const near = germanScore(this.recent.slice(-4).join(' '));
    const wide = germanScore(this.recent.join(' '));
    if (this.verdict !== 'german' && near.words >= 6 && near.distinct >= 2 && near.score >= 0.2) this.verdict = 'german';
    else if (this.verdict !== 'other' && wide.words >= 24 && wide.score < 0.08 && wide.distinct <= 1) this.verdict = 'other';
    return this.verdict;
  }
}

function area(r: DOMRect): number {
  return Math.max(0, r.width) * Math.max(0, r.height);
}

/** The element that holds the player: the largest ancestor that is not much bigger than the video. */
export function playerRoot(video: HTMLVideoElement): HTMLElement {
  const v = area(video.getBoundingClientRect()) || 1;
  let root: HTMLElement = video.parentElement ?? document.body;
  let el: HTMLElement | null = root;
  for (let depth = 0; el && el !== document.body && depth < 8; depth++, el = el.parentElement) {
    if (area(el.getBoundingClientRect()) <= v * 1.8) root = el;
  }
  return root;
}

export interface DomCaptionOptions {
  /** Look only for these selectors (site adapters know theirs); otherwise known selectors + heuristics. */
  selectors?: string[];
  /** Where to look; defaults to the player root of the video. */
  root?: HTMLElement;
}

export class DomCaptionReader {
  private observer: MutationObserver | null = null;
  private element: HTMLElement | null = null;
  private last = '';
  private frame = 0;
  private hidden = false;
  private hiddenElement: HTMLElement | null = null;
  private lastFind = -Infinity;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private root: HTMLElement;

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly onLine: (text: string | null) => void,
    private readonly options: DomCaptionOptions = {},
  ) {
    this.root = options.root ?? playerRoot(video);
  }

  start(): void {
    this.observer = new MutationObserver(() => this.schedule());
    // The fullscreen element may be an ancestor of the root; captions stay inside the player either way.
    this.observer.observe(this.root, { childList: true, subtree: true, characterData: true });
    this.read();
  }

  stop(): void {
    this.observer?.disconnect();
    this.observer = null;
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.restoreHidden();
    this.element = null;
  }

  /** Hides the site's own caption rendering (the text stays readable for us). */
  setHidden(hidden: boolean): void {
    this.hidden = hidden;
    this.applyHidden();
  }

  get found(): boolean {
    return this.element !== null;
  }

  private schedule(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.read();
    });
  }

  private read(): void {
    if (!this.element || !this.element.isConnected) {
      // Searching walks the player; players change their DOM many times a second, so at most once a second.
      const now = performance.now();
      if (now - this.lastFind < 1000) {
        this.retryTimer ??= setTimeout(() => {
          this.retryTimer = undefined;
          this.read();
        }, 1000 - (now - this.lastFind));
        return;
      }
      this.lastFind = now;
      this.element = this.find();
      this.applyHidden();
    }
    const raw = this.element ? (this.element.innerText || this.element.textContent || '') : '';
    const text = normalizeCueText(raw.replace(/\n+/g, ' '));
    if (text === this.last) return;
    this.last = text;
    this.onLine(text.length > 0 && text.length <= MAX_LINE ? text : null);
  }

  private find(): HTMLElement | null {
    const scopes: ParentNode[] = [this.root];
    if (document.fullscreenElement && document.fullscreenElement !== this.root) scopes.push(document.fullscreenElement);
    for (const scope of scopes) {
      for (const selector of this.options.selectors ?? KNOWN_CAPTION_SELECTORS) {
        const el = scope.querySelector<HTMLElement>(selector);
        if (el) return el;
      }
    }
    if (this.options.selectors) return null;
    return this.guess();
  }

  /** Heuristic: an element named like a caption container, inside the video area, with short text and no controls. */
  private guess(): HTMLElement | null {
    const v = this.video.getBoundingClientRect();
    let best: HTMLElement | null = null;
    for (const el of Array.from(this.root.querySelectorAll<HTMLElement>('[class], [id], [data-testid]'))) {
      if (el.contains(this.video) || el.querySelector('button, input, select, video')) continue;
      const name = `${typeof el.className === 'string' ? el.className : ''} ${el.id} ${el.dataset.testid ?? ''}`;
      if (!CAPTION_HINT.test(name) || /menu|button|setting|toggle|icon|control/i.test(name)) continue;
      const r = el.getBoundingClientRect();
      const inside = r.width === 0 || (r.left < v.right && r.right > v.left && r.top < v.bottom && r.bottom > v.top + v.height * 0.3);
      if (!inside) continue;
      // Prefer the outermost match: it holds all lines of a two-line caption.
      if (!best || el.contains(best)) best = el;
    }
    return best;
  }

  private applyHidden(): void {
    if (this.hiddenElement && this.hiddenElement !== this.element) this.restoreHidden();
    if (!this.element) return;
    if (this.hidden) {
      this.element.style.setProperty('opacity', '0', 'important');
      this.hiddenElement = this.element;
    } else this.restoreHidden();
  }

  private restoreHidden(): void {
    this.hiddenElement?.style.removeProperty('opacity');
    this.hiddenElement = null;
  }
}

export interface GermanCaptionEvents {
  /** A German line appeared (null: the caption was cleared or is no longer German). */
  line(text: string | null): void;
  /** The stream was found to be German, or not German. */
  language(verdict: 'german' | 'other'): void;
}

/**
 * DomCaptionReader behind a LanguageGate: passes on lines only while the captions are German,
 * and hides the site's own captions only then, so foreign captions stay where they were.
 */
export class GermanCaptionReader {
  private readonly gate = new LanguageGate();
  private readonly reader: DomCaptionReader;
  private announced: LanguageVerdict = 'unknown';
  private hide = false;

  constructor(
    video: HTMLVideoElement,
    private readonly events: GermanCaptionEvents,
    options: DomCaptionOptions = {},
  ) {
    this.reader = new DomCaptionReader(video, (text) => this.onLine(text), options);
  }

  get german(): boolean {
    return this.announced === 'german';
  }

  start(): void {
    this.reader.setHidden(false);
    this.reader.start();
  }

  stop(): void {
    if (this.german) this.events.line(null);
    this.reader.stop();
  }

  setHidden(hidden: boolean): void {
    this.hide = hidden;
    this.reader.setHidden(hidden && this.german);
  }

  private onLine(text: string | null): void {
    if (text === null) {
      if (this.german) this.events.line(null);
      return;
    }
    const verdict = this.gate.add(text);
    if (verdict !== 'unknown' && verdict !== this.announced) {
      const wasGerman = this.german;
      this.announced = verdict;
      this.reader.setHidden(this.hide && verdict === 'german');
      if (wasGerman) this.events.line(null);
      this.events.language(verdict);
    }
    if (this.german) this.events.line(text);
  }
}

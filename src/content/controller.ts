// Content-script controller: connects the subtitle adapter, the timeline, the translation
// client and the overlay. It owns all per-page state, so a restart of the background service
// worker loses nothing: pending requests are simply sent again.
import { buildUnits, contextFor, indexUnitsByCue, type TranslationUnit } from '../core/context.ts';
import { Timeline } from '../core/timeline.ts';
import type { PageState, ServerMessage } from '../shared/messages';
import { DEFAULT_SETTINGS, loadSettings, onSettingsChanged, type Settings } from '../shared/settings.ts';
import { tokenize } from '../shared/text.ts';
import type { AdapterStatus, Cue, Priority, SentenceAnalysis, TrackInfo, TranslateItem, WordAnalysis } from '../shared/types';
import type { AdapterSink, OverlayMount, SubtitleAdapter } from './adapters/types';
import { BackgroundClient } from './client.ts';
import { Overlay, type OverlayHost } from './overlay/overlay.ts';

const VIDEO_EVENTS = ['timeupdate', 'seeking', 'seeked', 'play', 'playing', 'pause', 'ratechange'] as const;
/** A failed translation is retried after this pause. */
const RETRY_AFTER_MS = 12_000;

interface StoredTranslation {
  text: string;
  provisional: boolean;
}

export class Controller implements AdapterSink, OverlayHost {
  private settings: Settings = DEFAULT_SETTINGS;
  private readonly overlay = new Overlay(this);
  private readonly client = new BackgroundClient(
    (message) => this.onServerMessage(message),
    () => this.onReconnect(),
  );
  private started = false;
  private video: HTMLVideoElement | null = null;
  private suspended = false;

  private status: AdapterStatus = { code: 'searching' };
  private tracks: TrackInfo[] = [];
  private activeTrackId: string | null = null;

  private timeline = new Timeline([]);
  private units: TranslationUnit[] = [];
  private unitByCue = new Map<number, TranslationUnit>();
  /** Changes with every new cue list; stale answers are recognised by it. */
  private session = 0;
  private liveMode = false;
  private readonly translations = new Map<number, StoredTranslation>();
  private readonly requested = new Map<number, Priority>();
  private readonly failedAt = new Map<number, number>();
  /** Why the translation of a unit failed, shown when that unit is on screen. */
  private readonly errors = new Map<number, string>();
  private errorShownFor: number | null = null;
  private readonly analyses = new Map<number, SentenceAnalysis | 'pending'>();
  private readonly analysedWithTranslation = new Set<number>();
  private readonly analysisRequests = new Map<number, { session: number; unit: number }>();
  private readonly wordRequests = new Map<number, { session: number; unit: number; token: number }>();
  private readonly wordsAsked = new Set<string>();
  private currentCue = -1;
  private currentUnit: TranslationUnit | null = null;
  private boundaryTimer: ReturnType<typeof setTimeout> | undefined;
  private nextId = 1;
  private pausedByPanel = false;
  private loadingShown = false;

  constructor(private readonly adapter: SubtitleAdapter) {}

  async init(): Promise<void> {
    this.settings = await loadSettings();
    this.overlay.applySettings(this.settings);
    onSettingsChanged((next) => this.onSettings(next));
    if (this.settings.enabled) this.start();
  }

  private start(): void {
    if (this.started) return;
    this.started = true;
    this.adapter.start(this);
    this.adapter.setNativeHidden(true);
  }

  private stop(): void {
    if (!this.started) return;
    this.started = false;
    this.adapter.setNativeHidden(false);
    this.adapter.stop();
    this.onVideo(null);
    this.resetCues([]);
    this.client.send({ t: 'cancel', keep: [] });
  }

  private onSettings(next: Settings): void {
    const prev = this.settings;
    this.settings = next;
    this.overlay.applySettings(next);
    if (next.enabled !== prev.enabled) {
      if (next.enabled) this.start();
      else this.stop();
      return;
    }
    if (!this.started) return;
    if (next.mergeFragments !== prev.mergeFragments && !this.liveMode) {
      this.resetCues([...this.timeline.cues]);
    } else if (next.mode !== prev.mode || next.localProvider !== prev.localProvider || next.ollamaModel !== prev.ollamaModel) {
      // Another translator: forget what the previous one produced and ask again.
      this.translations.clear();
      this.requested.clear();
      this.failedAt.clear();
      this.errors.clear();
      this.client.send({ t: 'cancel', keep: [] });
      this.currentCue = -1;
    }
    this.tick();
  }

  // ── AdapterSink ──

  onVideo(mount: OverlayMount | null): void {
    if (this.video) for (const type of VIDEO_EVENTS) this.video.removeEventListener(type, this.onVideoEvent);
    this.video = mount?.video ?? null;
    if (!mount) {
      this.overlay.unmount();
      return;
    }
    this.overlay.mount(mount);
    this.overlay.applySettings(this.settings);
    for (const type of VIDEO_EVENTS) mount.video.addEventListener(type, this.onVideoEvent, { passive: true });
    this.tick();
  }

  onTracks(tracks: TrackInfo[], activeTrackId: string | null): void {
    this.tracks = tracks;
    this.activeTrackId = activeTrackId;
  }

  onCues(cues: Cue[]): void {
    this.liveMode = false;
    this.resetCues(cues);
    this.tick();
  }

  onLiveLine(text: string | null): void {
    if (!this.liveMode) {
      this.resetCues([]);
      this.liveMode = true;
    }
    if (!text) {
      this.currentUnit = null;
      this.overlay.showCue(null);
      this.overlay.setRussian({ kind: 'none' });
      return;
    }
    // Each rendered line becomes a unit of its own; earlier lines serve as context.
    const unit: TranslationUnit = { index: this.units.length, cueIndexes: [this.units.length], text, start: 0, end: 0, tokenOffsets: [0] };
    this.units.push(unit);
    this.currentUnit = unit;
    this.overlay.showCue({ unitIndex: unit.index, text, tokens: tokenize(text), tokenOffset: 0 });
    this.showTranslation(unit, false);
    this.request([{ unit, priority: 0 }]);
    this.ensureAnalysis(unit);
  }

  onStatus(status: AdapterStatus): void {
    this.status = status;
    if (status.code === 'no-german' || status.code === 'no-subtitles' || status.code === 'blocked') {
      const text =
        status.code === 'no-german' ? 'немецких субтитров нет' : status.code === 'no-subtitles' ? 'у видео нет субтитров' : 'текст субтитров недоступен';
      this.overlay.setStatus(text, 'info', 6000);
    }
  }

  onBottomInset(pixels: number): void {
    this.overlay.setBottomInset(pixels);
  }

  onSuspend(suspended: boolean): void {
    this.suspended = suspended;
    this.overlay.setVisible(!suspended);
    if (!suspended) {
      this.currentCue = -1;
      this.tick();
    }
  }

  // ── state shown in the extension popup ──

  pageState(): PageState | null {
    if (!this.video) return null;
    return { adapter: this.adapter.id, status: this.status, tracks: this.tracks, activeTrackId: this.activeTrackId, cueCount: this.timeline.length };
  }

  selectTrack(id: string): void {
    this.adapter.selectTrack(id);
  }

  // ── cues and playback ──

  private resetCues(cues: Cue[]): void {
    this.session++;
    this.timeline = new Timeline(cues);
    this.units = buildUnits(this.timeline.cues, { mergeFragments: this.settings.mergeFragments });
    this.unitByCue = indexUnitsByCue(this.units);
    this.translations.clear();
    this.requested.clear();
    this.failedAt.clear();
    this.errors.clear();
    this.errorShownFor = null;
    this.analyses.clear();
    this.analysedWithTranslation.clear();
    this.analysisRequests.clear();
    this.wordRequests.clear();
    this.wordsAsked.clear();
    this.currentCue = -1;
    this.currentUnit = null;
    clearTimeout(this.boundaryTimer);
    this.overlay.showCue(null);
    this.overlay.setRussian({ kind: 'none' });
    this.client.send({ t: 'cancel', keep: [] });
  }

  private readonly onVideoEvent = (event: Event): void => {
    if (event.type === 'seeked') this.onSeek();
    if (event.type === 'play') this.pausedByPanel = false;
    this.tick();
  };

  private tick(): void {
    const video = this.video;
    if (!video || !this.started || this.suspended || this.liveMode) return;
    const time = video.currentTime;
    const cue = this.timeline.at(time);
    const index = cue?.index ?? -1;
    if (index !== this.currentCue) {
      this.currentCue = index;
      this.renderCue(cue);
    }
    // `timeupdate` fires only about four times a second; a timer hits the next boundary precisely.
    clearTimeout(this.boundaryTimer);
    if (!video.paused) {
      const next = this.timeline.nextBoundary(time);
      if (next !== null) {
        const wait = ((next - time) / (video.playbackRate || 1)) * 1000;
        if (wait < 400) this.boundaryTimer = setTimeout(() => this.tick(), Math.max(4, wait + 8));
      }
    }
    this.preload(time);
  }

  private renderCue(cue: Cue | null): void {
    if (!cue) {
      this.currentUnit = null;
      this.overlay.showCue(null);
      this.overlay.setRussian({ kind: 'none' });
      return;
    }
    const unit = this.unitByCue.get(cue.index) ?? null;
    this.currentUnit = unit;
    const position = unit ? unit.cueIndexes.indexOf(cue.index) : -1;
    this.overlay.showCue({
      unitIndex: unit?.index ?? -1,
      text: cue.text,
      tokens: unit ? tokenize(cue.text) : tokenize(cue.text).map((t) => ({ ...t, kind: 'punct' as const })),
      tokenOffset: unit && position >= 0 ? (unit.tokenOffsets[position] ?? 0) : 0,
    });
    if (!unit) {
      this.overlay.setRussian({ kind: 'none' });
      return;
    }
    this.showTranslation(unit, false);
    this.ensureAnalysis(unit);
  }

  private showTranslation(unit: TranslationUnit, late: boolean): void {
    if (!this.settings.showRussian) {
      this.overlay.setRussian({ kind: 'none' });
      return;
    }
    const stored = this.translations.get(unit.index);
    if (stored) this.overlay.setRussian({ kind: 'text', text: stored.text, late });
    else if (this.failedAt.has(unit.index)) {
      this.overlay.setRussian({ kind: 'none' });
      // Preloaded lines fail before they are on screen: say why when the line appears.
      const error = this.errors.get(unit.index);
      if (error && this.errorShownFor !== unit.index) {
        this.errorShownFor = unit.index;
        this.overlay.setStatus(error, 'error', 8000);
      }
    } else this.overlay.setRussian({ kind: 'pending' });
  }

  /** Requests translations for the unit on screen and the ones coming up. */
  private preload(time: number): void {
    if (!this.settings.showRussian || this.units.length === 0) return;
    let first = this.currentUnit?.index ?? -1;
    if (first < 0) {
      const cueIndex = this.timeline.indexFrom(time);
      for (let i = cueIndex; i < this.timeline.length && first < 0; i++) first = this.unitByCue.get(i)?.index ?? -1;
      if (first < 0) return;
    }
    const wanted: { unit: TranslationUnit; priority: Priority }[] = [];
    for (let k = 0; k <= this.settings.preloadAhead; k++) {
      const unit = this.units[first + k];
      if (!unit) break;
      wanted.push({ unit, priority: unit === this.currentUnit ? 0 : k <= 2 ? 1 : 2 });
    }
    this.request(wanted);
  }

  private request(wanted: { unit: TranslationUnit; priority: Priority }[]): void {
    const now = Date.now();
    const items: TranslateItem[] = [];
    for (const { unit, priority } of wanted) {
      const stored = this.translations.get(unit.index);
      if (stored && !stored.provisional) continue;
      const already = this.requested.get(unit.index);
      if (already !== undefined && already <= priority) continue;
      const failed = this.failedAt.get(unit.index);
      if (failed !== undefined && now - failed < RETRY_AFTER_MS) continue;
      this.requested.set(unit.index, priority);
      const context = this.liveMode
        ? { before: this.units.slice(Math.max(0, unit.index - this.settings.contextSize), unit.index).map((u) => u.text), after: [] }
        : contextFor(this.units, unit.index, this.settings.contextSize);
      items.push({ key: `${this.session}:${unit.index}`, text: unit.text, before: context.before, after: context.after, priority });
    }
    if (items.length > 0 && !this.client.send({ t: 'translate', items })) this.dispose();
  }

  private onSeek(): void {
    // Requests for the part of the video we left are dropped; they must not delay the new position.
    const time = this.video?.currentTime ?? 0;
    const cueIndex = this.timeline.indexFrom(time);
    let first = -1;
    for (let i = cueIndex; i < this.timeline.length && first < 0; i++) first = this.unitByCue.get(i)?.index ?? -1;
    const keep: string[] = [];
    for (const unitIndex of [...this.requested.keys()]) {
      if (first >= 0 && unitIndex >= first && unitIndex <= first + this.settings.preloadAhead) keep.push(`${this.session}:${unitIndex}`);
      else this.requested.delete(unitIndex);
    }
    this.client.send({ t: 'cancel', keep });
  }

  private onReconnect(): void {
    // The background worker restarted and lost its queue: ask again for everything still open.
    this.requested.clear();
    for (const [unit, state] of this.analyses) if (state === 'pending') this.analyses.delete(unit);
    this.analysisRequests.clear();
    this.wordRequests.clear();
    if (this.liveMode) {
      if (this.currentUnit) this.request([{ unit: this.currentUnit, priority: 0 }]);
    } else {
      this.tick();
    }
    if (this.currentUnit) this.ensureAnalysis(this.currentUnit);
  }

  // ── messages from the background ──

  private unitOfKey(key: string): TranslationUnit | null {
    const [session, index] = key.split(':').map(Number);
    if (session !== this.session || index === undefined) return null;
    return this.units[index] ?? null;
  }

  private onServerMessage(message: ServerMessage): void {
    switch (message.t) {
      case 'translated': {
        const unit = this.unitOfKey(message.result.key);
        if (!unit) return;
        const provisional = message.result.provisional === true;
        const existing = this.translations.get(unit.index);
        if (provisional && existing && !existing.provisional) return; // never downgrade
        this.translations.set(unit.index, { text: message.result.text, provisional });
        if (!provisional) this.requested.delete(unit.index);
        this.failedAt.delete(unit.index);
        if (unit === this.currentUnit) {
          this.showTranslation(unit, existing?.text !== message.result.text);
          // The translation helps to choose the right dictionary sense: analyse again with it.
          if (!this.analysedWithTranslation.has(unit.index)) {
            this.analyses.delete(unit.index);
            this.ensureAnalysis(unit);
          }
        }
        if (this.loadingShown) {
          this.loadingShown = false;
          this.overlay.setStatus(null);
        }
        return;
      }
      case 'translate-error': {
        const unit = this.unitOfKey(message.key);
        if (!unit) return;
        this.requested.delete(unit.index);
        if (this.translations.has(unit.index)) return; // a provisional translation stays on screen
        this.failedAt.set(unit.index, Date.now());
        this.errors.set(unit.index, message.error.message);
        if (unit === this.currentUnit) {
          this.errorShownFor = null;
          this.showTranslation(unit, false);
        }
        return;
      }
      case 'analysis': {
        const request = this.analysisRequests.get(message.id);
        this.analysisRequests.delete(message.id);
        if (!request || request.session !== this.session) return;
        if (message.analysis) this.analyses.set(request.unit, message.analysis);
        else this.analyses.delete(request.unit);
        this.overlay.refreshUnit(request.unit);
        return;
      }
      case 'word-context': {
        const request = this.wordRequests.get(message.id);
        this.wordRequests.delete(message.id);
        if (!request || request.session !== this.session || !message.text) return;
        const analysis = this.analyses.get(request.unit);
        const word = analysis && analysis !== 'pending' ? analysis.words[request.token] : null;
        if (!word) return;
        word.translation = { ...word.translation, contextual: { value: message.text, certainty: 'likely', source: 'llm' } };
        this.overlay.refreshUnit(request.unit);
        return;
      }
      case 'provider-status': {
        const { status } = message;
        if (status.state === 'loading' && this.currentUnit && !this.translations.has(this.currentUnit.index)) {
          const percent = status.progress !== undefined ? ` ${Math.round(status.progress * 100)}%` : '';
          this.overlay.setStatus(`загружается модель перевода…${percent}`, 'info', 0);
          this.loadingShown = true;
        } else if (this.loadingShown && status.state !== 'loading') {
          this.loadingShown = false;
          this.overlay.setStatus(null);
        }
        return;
      }
      case 'pong':
        return;
    }
  }

  // ── word analysis ──

  private ensureAnalysis(unit: TranslationUnit): void {
    if (!this.settings.wordPopup || this.analyses.has(unit.index)) return;
    const translation = this.translations.get(unit.index)?.text;
    const id = this.nextId++;
    this.analyses.set(unit.index, 'pending');
    this.analysisRequests.set(id, { session: this.session, unit: unit.index });
    if (translation) this.analysedWithTranslation.add(unit.index);
    if (!this.client.send({ t: 'analyze', id, sentence: unit.text, translation })) this.dispose();
  }

  // ── OverlayHost ──

  word(unitIndex: number, tokenIndex: number): WordAnalysis | 'pending' | null {
    const unit = this.units[unitIndex];
    if (!unit) return null;
    const analysis = this.analyses.get(unitIndex);
    if (!analysis) {
      this.ensureAnalysis(unit);
      return 'pending';
    }
    if (analysis === 'pending') return 'pending';
    return analysis.words[tokenIndex] ?? null;
  }

  wordOpened(unitIndex: number, tokenIndex: number): void {
    const unit = this.units[unitIndex];
    const key = `${unitIndex}:${tokenIndex}`;
    if (!unit || this.wordsAsked.has(key)) return;
    this.wordsAsked.add(key);
    // If a context-aware model is active, the background answers with the meaning in this sentence.
    const id = this.nextId++;
    this.wordRequests.set(id, { session: this.session, unit: unitIndex, token: tokenIndex });
    this.client.send({ t: 'word-context', id, sentence: unit.text, tokenIndex });
  }

  panelOpened(): void {
    const video = this.video;
    if (this.settings.pauseOnHover && video && !video.paused && !video.ended) {
      video.pause();
      this.pausedByPanel = true;
    }
  }

  panelClosed(): void {
    if (this.pausedByPanel && this.video?.paused) void this.video.play().catch(() => undefined);
    this.pausedByPanel = false;
  }

  /** The extension was reloaded or removed: leave the page as we found it. */
  private dispose(): void {
    if (!this.client.orphaned) return;
    this.stop();
    this.overlay.unmount();
  }
}

// Generic adapter for any page with a <video>. Reads the standard text tracks when there is a
// German one; otherwise reads the subtitles the player draws as page text (dom-captions.ts).
import type { AdapterStatus, Cue, TrackInfo } from '../../shared/types';
import { normalizeCueText } from '../../shared/text.ts';
import { GermanCaptionReader } from './dom-captions.ts';
import { looksGerman, type AdapterSink, type SubtitleAdapter } from './types.ts';

const MAX_CUES = 20_000;

function isUsableKind(track: TextTrack): boolean {
  return track.kind === 'subtitles' || track.kind === 'captions';
}

function area(video: HTMLVideoElement): number {
  const rect = video.getBoundingClientRect();
  return rect.width * rect.height;
}

export class Html5Adapter implements SubtitleAdapter {
  readonly id = 'html5';

  private sink: AdapterSink | null = null;
  private video: HTMLVideoElement | null = null;
  private track: TextTrack | null = null;
  private userChoice: string | null = null;
  private domWatcher: MutationObserver | null = null;
  private scanTimer: ReturnType<typeof setTimeout> | undefined;
  private cueCount = -1;
  private nativeHidden = true;
  /** Modes we changed, so that they can be restored. */
  private readonly originalModes = new WeakMap<TextTrack, TextTrackMode>();
  private blockedTimer: ReturnType<typeof setTimeout> | undefined;
  private retryTimers: ReturnType<typeof setTimeout>[] = [];
  private trackElement: HTMLTrackElement | null = null;
  private trackErrorHandler: (() => void) | null = null;
  private reader: GermanCaptionReader | null = null;
  private readerVideo: HTMLVideoElement | null = null;

  start(sink: AdapterSink): void {
    this.sink = sink;
    sink.onStatus({ code: 'searching' });
    this.scan();
    // Videos are often inserted later. The script runs on every page, so mutations are not
    // inspected one by one: at most every 400 ms the page is checked for a different main video.
    this.domWatcher = new MutationObserver(() => {
      if (this.scanTimer !== undefined) return;
      this.scanTimer = setTimeout(() => {
        this.scanTimer = undefined;
        this.scan();
      }, 400);
    });
    this.domWatcher.observe(document.documentElement, { childList: true, subtree: true });
  }

  stop(): void {
    this.domWatcher?.disconnect();
    clearTimeout(this.scanTimer);
    this.scanTimer = undefined;
    clearTimeout(this.blockedTimer);
    this.detachVideo();
    this.sink = null;
  }

  selectTrack(id: string): void {
    this.userChoice = id;
    this.chooseTrack();
  }

  setNativeHidden(hidden: boolean): void {
    this.nativeHidden = hidden;
    this.reader?.setHidden(hidden);
    if (!this.track) return;
    if (hidden) this.track.mode = 'hidden';
    else this.track.mode = this.originalModes.get(this.track) === 'showing' ? 'showing' : 'hidden';
  }

  // ── video discovery ──

  private scan(): void {
    const videos = Array.from(document.querySelectorAll('video'));
    // The main video is the largest one; tiny preview players and hidden elements lose.
    const best = videos.sort((a, b) => area(b) - area(a))[0] ?? null;
    if (best === this.video) return;
    this.detachVideo();
    this.video = best;
    if (!best) {
      this.sink?.onVideo(null);
      this.sink?.onStatus({ code: 'no-video' });
      return;
    }
    const tracks = best.textTracks;
    tracks.addEventListener('addtrack', this.onTrackListChange);
    tracks.addEventListener('removetrack', this.onTrackListChange);
    best.addEventListener('loadedmetadata', this.onTrackListChange);
    best.addEventListener('emptied', this.onEmptied);
    this.sink?.onVideo({ container: best.parentElement ?? document.body, video: best, mode: 'fixed' });
    // Keep clear of the browser's own control bar.
    this.sink?.onBottomInset(best.controls ? 62 : 0);
    this.chooseTrack();
  }

  private detachVideo(): void {
    this.releaseTrack();
    this.stopReader();
    const video = this.video;
    if (!video) return;
    video.textTracks.removeEventListener('addtrack', this.onTrackListChange);
    video.textTracks.removeEventListener('removetrack', this.onTrackListChange);
    video.removeEventListener('loadedmetadata', this.onTrackListChange);
    video.removeEventListener('emptied', this.onEmptied);
    this.video = null;
  }

  private readonly onTrackListChange = (): void => {
    this.chooseTrack();
  };

  private readonly onEmptied = (): void => {
    this.releaseTrack();
    this.userChoice = null;
    this.sink?.onCues([]);
    this.chooseTrack();
  };

  // ── tracks ──

  private list(): { track: TextTrack; info: TrackInfo }[] {
    if (!this.video) return [];
    return Array.from(this.video.textTracks)
      .map((track, i) => ({ track, i }))
      .filter(({ track }) => isUsableKind(track) && track.label !== 'Mitlesen')
      .map(({ track, i }) => ({
        track,
        info: {
          id: `${i}|${track.language}|${track.label}`,
          language: track.language,
          label: track.label || track.language || `Дорожка ${i + 1}`,
          kind: 'unknown' as const,
          isGerman: looksGerman(track.language, track.label),
        },
      }));
  }

  private chooseTrack(): void {
    if (!this.sink || !this.video) return;
    const all = this.list();
    const chosen = all.find((t) => t.info.id === this.userChoice) ?? all.find((t) => t.info.isGerman) ?? null;
    this.sink.onTracks(all.map((t) => t.info), chosen?.info.id ?? null);
    if (all.length === 0) {
      this.releaseTrack();
      this.startReader({ code: 'no-subtitles', detail: 'У видео нет текстовых дорожек, и субтитров на экране пока не видно. Если они есть, включите их в плеере.' });
      return;
    }
    if (!chosen) {
      this.releaseTrack();
      this.startReader({ code: 'no-german', detail: `Немецкой дорожки нет. Доступны: ${all.map((t) => t.info.label).join(', ')}.` });
      return;
    }
    if (chosen.track === this.track) return;
    this.stopReader();
    this.releaseTrack();
    this.track = chosen.track;
    if (!this.originalModes.has(chosen.track)) this.originalModes.set(chosen.track, chosen.track.mode);
    // `hidden` loads the cues and fires events without drawing the browser's own subtitles.
    chosen.track.mode = this.nativeHidden ? 'hidden' : chosen.track.mode === 'disabled' ? 'hidden' : chosen.track.mode;
    chosen.track.addEventListener('cuechange', this.readCues);
    this.cueCount = -1;
    this.sink.onStatus({ code: 'waiting-captions', detail: chosen.info.label });
    this.readCues();
    // The cue list fills when the subtitle file has loaded. A <track> element announces that
    // with a `load` event; tracks filled by a script have no such event, so look again a few times.
    const blocked = (): void => {
      if (this.track === chosen.track && this.cueCount <= 0) {
        this.sink?.onStatus({
          code: 'blocked',
          detail: 'Дорожка найдена, но её текст недоступен: файл субтитров не загрузился или лежит на другом домене без разрешения на чтение.',
        });
      }
    };
    this.trackElement = Array.from(this.video.querySelectorAll('track')).find((el) => el.track === chosen.track) ?? null;
    this.trackElement?.addEventListener('load', this.readCues);
    this.trackElement?.addEventListener('error', blocked);
    this.trackErrorHandler = blocked;
    for (const delay of [250, 1000, 2500, 5000]) this.retryTimers.push(setTimeout(this.readCues, delay));
    clearTimeout(this.blockedTimer);
    this.blockedTimer = setTimeout(blocked, 8000);
  }

  private releaseTrack(): void {
    const track = this.track;
    if (!track) return;
    track.removeEventListener('cuechange', this.readCues);
    this.trackElement?.removeEventListener('load', this.readCues);
    if (this.trackErrorHandler) this.trackElement?.removeEventListener('error', this.trackErrorHandler);
    this.trackElement = null;
    this.trackErrorHandler = null;
    for (const timer of this.retryTimers) clearTimeout(timer);
    this.retryTimers = [];
    const original = this.originalModes.get(track);
    if (original) track.mode = original;
    this.track = null;
    this.cueCount = -1;
    clearTimeout(this.blockedTimer);
  }

  // ── subtitles drawn by the player ──

  /**
   * Watches the player for subtitle text it renders itself. `fallback` is the status to show
   * while nothing German has been seen on screen.
   */
  private startReader(fallback: AdapterStatus): void {
    const sink = this.sink;
    const video = this.video;
    if (!sink || !video) return;
    if (this.reader && this.readerVideo === video) {
      if (!this.reader.german) sink.onStatus(fallback);
      return;
    }
    this.stopReader();
    this.readerVideo = video;
    this.reader = new GermanCaptionReader(video, {
      line: (text) => this.sink?.onLiveLine(text),
      language: (verdict) =>
        this.sink?.onStatus(
          verdict === 'german'
            ? { code: 'ready', detail: 'субтитры читаются с экрана, без перевода наперёд' }
            : { code: 'no-german', detail: 'Субтитры на экране не на немецком.' },
        ),
    });
    this.reader.setHidden(this.nativeHidden);
    this.reader.start();
    sink.onStatus(fallback);
  }

  private stopReader(): void {
    this.reader?.stop();
    this.reader = null;
    this.readerVideo = null;
  }

  /** Re-reads the cue list when its length changed (streams add cues as they play). */
  private readonly readCues = (): void => {
    const list = this.track?.cues;
    if (!list || !this.sink || list.length === this.cueCount) return;
    this.cueCount = list.length;
    const cues: Cue[] = [];
    for (let i = 0; i < list.length && cues.length < MAX_CUES; i++) {
      const cue = list[i] as VTTCue | undefined;
      if (!cue) continue;
      const text = normalizeCueText(typeof cue.text === 'string' ? cue.text : '');
      if (text.length === 0 || !(cue.endTime > cue.startTime)) continue;
      cues.push({ index: cues.length, start: cue.startTime, end: cue.endTime, text });
    }
    if (cues.length === 0) return;
    clearTimeout(this.blockedTimer);
    this.sink.onCues(cues);
    this.sink.onStatus({ code: 'ready' });
  };
}

// YouTube adapter (isolated world). Works together with src/inject/youtube-main.ts, which
// relays the player's own subtitle downloads and exposes the player's caption API.
import type { Cue, TrackInfo } from '../../shared/types';
import { normalizeCueText } from '../../shared/text.ts';
import { looksGerman, type AdapterSink, type SubtitleAdapter } from './types.ts';
import { parseTimedText, parseTimedTextUrl, speechShare } from './youtube-parse.ts';

interface PlayerTrack {
  languageCode?: string;
  languageName?: string;
  displayName?: string;
  kind?: string;
  vss_id?: string;
}

interface TracksMessage {
  tracks: PlayerTrack[];
  active: PlayerTrack | null;
  videoId: string | null;
  ready: boolean;
}

const CHANNEL = 'mitlesen';
const HIDE_CLASS = 'mitlesen-native-hidden';
const MAX_BODY_CHARS = 8_000_000;
const MAX_CUES = 20_000;

function trackId(t: PlayerTrack): string {
  return `${t.languageCode ?? ''}|${t.kind === 'asr' ? 'asr' : ''}`;
}

function toInfo(t: PlayerTrack): TrackInfo {
  const kind = t.kind === 'asr' ? 'asr' : 'manual';
  const name = t.displayName || t.languageName || t.languageCode || '?';
  return { id: trackId(t), language: t.languageCode ?? '', label: name, kind, isGerman: looksGerman(t.languageCode ?? '', name) };
}

export class YouTubeAdapter implements SubtitleAdapter {
  readonly id = 'youtube';

  private sink: AdapterSink | null = null;
  private video: HTMLVideoElement | null = null;
  private playerEl: HTMLElement | null = null;
  private tracks: PlayerTrack[] = [];
  private videoId: string | null = null;
  /** Track chosen by the user in the extension popup, if any. */
  private userChoice: string | null = null;
  /** Track we asked the player to load. */
  private targetId: string | null = null;
  /** Track whose cues were delivered to the sink. */
  private deliveredId: string | null = null;
  private seq = 0;
  private readonly pending = new Map<number, (data: unknown) => void>();
  private finder: MutationObserver | null = null;
  private classWatcher: MutationObserver | null = null;
  private liveWatcher: MutationObserver | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private watchdog: ReturnType<typeof setTimeout> | undefined;
  private style: HTMLStyleElement | null = null;
  private nativeHidden = false;
  private refreshToken = 0;
  /** The player asked for the track and got an empty answer. */
  private emptyAnswer = false;

  start(sink: AdapterSink): void {
    this.sink = sink;
    window.addEventListener('message', this.onMessage);
    this.style = document.createElement('style');
    this.style.textContent = `html.${HIDE_CLASS} .ytp-caption-window-container{opacity:0!important;pointer-events:none!important}`;
    (document.head ?? document.documentElement).append(this.style);
    sink.onStatus({ code: 'searching' });
    this.locatePlayer();
  }

  stop(): void {
    window.removeEventListener('message', this.onMessage);
    this.finder?.disconnect();
    this.classWatcher?.disconnect();
    this.liveWatcher?.disconnect();
    clearTimeout(this.retryTimer);
    clearTimeout(this.watchdog);
    this.video?.removeEventListener('loadedmetadata', this.onNewMedia);
    this.video?.removeEventListener('emptied', this.onEmptied);
    document.documentElement.classList.remove(HIDE_CLASS);
    this.style?.remove();
    this.sink = null;
  }

  selectTrack(id: string): void {
    this.userChoice = id;
    this.applyTarget();
  }

  setNativeHidden(hidden: boolean): void {
    this.nativeHidden = hidden;
    document.documentElement.classList.toggle(HIDE_CLASS, hidden && this.deliveredId !== null);
  }

  // ── player discovery ──

  private locatePlayer(): void {
    const attach = (): boolean => {
      const playerEl = document.querySelector<HTMLElement>('#movie_player, .html5-video-player');
      const video = playerEl?.querySelector<HTMLVideoElement>('video') ?? null;
      if (!playerEl || !video) return false;
      if (video === this.video && playerEl === this.playerEl) return true;
      this.video?.removeEventListener('loadedmetadata', this.onNewMedia);
      this.video?.removeEventListener('emptied', this.onEmptied);
      this.video = video;
      this.playerEl = playerEl;
      video.addEventListener('loadedmetadata', this.onNewMedia);
      video.addEventListener('emptied', this.onEmptied);
      this.sink?.onVideo({ container: playerEl, video, mode: 'inside' });
      this.watchPlayerChrome(playerEl);
      this.refreshTracks();
      return true;
    };
    if (attach()) return;
    // The player is created by script after navigation; wait for it without polling.
    this.finder?.disconnect();
    this.finder = new MutationObserver(() => {
      if (attach()) {
        this.finder?.disconnect();
        this.finder = null;
      }
    });
    this.finder.observe(document.documentElement, { childList: true, subtree: true });
  }

  /** Reports how much room the player controls take and whether an advertisement is playing. */
  private watchPlayerChrome(playerEl: HTMLElement): void {
    this.classWatcher?.disconnect();
    let lastInset = -1;
    let lastAd: boolean | null = null;
    const update = (): void => {
      const controlsVisible = !playerEl.classList.contains('ytp-autohide');
      const chrome = playerEl.querySelector<HTMLElement>('.ytp-chrome-bottom');
      const inset = controlsVisible && chrome ? chrome.offsetHeight + 10 : 0;
      if (inset !== lastInset) {
        lastInset = inset;
        this.sink?.onBottomInset(inset);
      }
      const ad = playerEl.classList.contains('ad-showing');
      if (ad !== lastAd) {
        lastAd = ad;
        this.sink?.onSuspend(ad);
      }
    };
    this.classWatcher = new MutationObserver(update);
    this.classWatcher.observe(playerEl, { attributes: true, attributeFilter: ['class'] });
    update();
  }

  private readonly onNewMedia = (): void => {
    this.refreshTracks();
  };

  private readonly onEmptied = (): void => {
    this.resetVideoState();
  };

  private resetVideoState(): void {
    this.deliveredId = null;
    this.targetId = null;
    this.userChoice = null;
    this.emptyAnswer = false;
    this.tracks = [];
    this.liveWatcher?.disconnect();
    this.liveWatcher = null;
    clearTimeout(this.watchdog);
    document.documentElement.classList.remove(HIDE_CLASS);
    this.sink?.onCues([]);
    this.sink?.onTracks([], null);
    this.sink?.onStatus({ code: 'searching' });
  }

  // ── messaging with the MAIN-world script ──

  private ask<T>(type: string, payload: Record<string, unknown> = {}): Promise<T | null> {
    return new Promise((resolve) => {
      const id = ++this.seq;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(null);
      }, 1500);
      this.pending.set(id, (data) => {
        clearTimeout(timer);
        resolve(data as T);
      });
      window.postMessage({ channel: CHANNEL, from: 'content', type, id, ...payload }, location.origin);
    });
  }

  private readonly onMessage = (event: MessageEvent): void => {
    if (event.source !== window || event.origin !== location.origin) return;
    const data = event.data as { channel?: string; from?: string; type?: string; id?: number; url?: unknown; body?: unknown } | null;
    if (!data || data.channel !== CHANNEL || data.from !== 'main') return;
    if (typeof data.id === 'number' && this.pending.has(data.id)) {
      this.pending.get(data.id)?.(data);
      this.pending.delete(data.id);
      return;
    }
    if (data.type === 'timedtext' && typeof data.url === 'string' && typeof data.body === 'string') {
      if (data.body.length <= MAX_BODY_CHARS) this.onTimedText(data.url, data.body);
    } else if (data.type === 'navigated' || data.type === 'hello') {
      this.locatePlayer();
      this.refreshTracks();
    }
  };

  // ── tracks ──

  private refreshTracks(attempt = 0): void {
    clearTimeout(this.retryTimer);
    const token = ++this.refreshToken;
    void this.ask<TracksMessage>('list-tracks').then((reply) => {
      if (token !== this.refreshToken || !this.sink) return;
      if (!reply || !reply.ready || (reply.tracks.length === 0 && attempt < 12)) {
        // The player or its caption module is still loading. Back off: 0.4 s … 2 s, about 15 s in total.
        if (attempt < 12) this.retryTimer = setTimeout(() => this.refreshTracks(attempt + 1), Math.min(2000, 400 + attempt * 200));
        else this.sink.onStatus({ code: 'no-subtitles', detail: 'Плеер YouTube не сообщил ни одной дорожки субтитров.' });
        return;
      }
      if (reply.videoId && reply.videoId !== this.videoId) {
        if (this.videoId !== null) this.resetVideoState();
        this.videoId = reply.videoId;
      }
      this.tracks = reply.tracks.filter((t) => typeof t.languageCode === 'string');
      this.sink.onTracks(this.tracks.map(toInfo), this.deliveredId);
      if (this.tracks.length === 0) {
        this.sink.onStatus({ code: 'no-subtitles', detail: 'У этого видео нет субтитров.' });
        return;
      }
      this.applyTarget(reply.active ? trackId(reply.active) : null);
    });
  }

  /** Picks the track to show (user choice, else manual German, else automatic German) and asks the player for it. */
  private applyTarget(activeInPlayer: string | null = null): void {
    if (!this.sink) return;
    const infos = this.tracks.map(toInfo);
    const chosen =
      infos.find((t) => t.id === this.userChoice) ??
      infos.find((t) => t.isGerman && t.kind === 'manual') ??
      infos.find((t) => t.isGerman);
    if (!chosen) {
      this.targetId = null;
      this.sink.onStatus({ code: 'no-german', detail: `Немецкой дорожки нет. Доступны: ${infos.map((t) => t.label).join(', ')}.` });
      return;
    }
    if (chosen.id === this.deliveredId) return;
    this.targetId = chosen.id;
    this.sink.onStatus({ code: 'waiting-captions', detail: chosen.label });
    const raw = this.tracks.find((t) => trackId(t) === chosen.id);
    if (!raw) return;
    const request = { languageCode: raw.languageCode, kind: raw.kind, vss_id: raw.vss_id };
    const load = async (): Promise<void> => {
      // If the player already shows this track, its download happened before we were listening:
      // switch captions off and on again to make the player fetch it once more.
      if (activeInPlayer === chosen.id) await this.ask('set-track', { track: null });
      await this.ask('set-track', { track: request });
    };
    void load();
    clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => {
      if (this.deliveredId === chosen.id) return;
      // Nothing was intercepted. Try once more, then fall back to reading the rendered captions.
      void this.ask('set-track', { track: null })
        .then(() => this.ask('set-track', { track: request }))
        .then(() => {
          this.watchdog = setTimeout(() => {
            if (this.deliveredId !== chosen.id) this.startLiveFallback(chosen.id);
          }, 4000);
        });
    }, 4000);
  }

  private onTimedText(url: string, body: string): void {
    if (!this.sink) return;
    const info = parseTimedTextUrl(url);
    if (!info) return;
    if (info.videoId && this.videoId && info.videoId !== this.videoId) return;
    const id = `${info.language}|${info.kind === 'asr' && !info.translated ? 'asr' : ''}`;
    const german = looksGerman(info.language, '');
    const wanted = id === this.targetId || (this.userChoice !== null && id === this.userChoice);
    if (!german && !wanted) {
      // The viewer picked another language in YouTube's own menu: step aside and show the native captions.
      if (this.deliveredId !== null) {
        this.deliveredId = null;
        this.sink.onCues([]);
      }
      document.documentElement.classList.remove(HIDE_CLASS);
      this.sink.onTracks(this.tracks.map(toInfo), null);
      this.sink.onStatus({ code: 'no-german', detail: 'В плеере выбрана не немецкая дорожка.' });
      return;
    }
    const cues: Cue[] = parseTimedText(body).slice(0, MAX_CUES);
    if (cues.length === 0 || speechShare(cues) === 0) {
      if (body.trim().length === 0 && id === this.targetId) this.emptyAnswer = true;
      return;
    }
    this.emptyAnswer = false;
    clearTimeout(this.watchdog);
    this.liveWatcher?.disconnect();
    this.liveWatcher = null;
    this.deliveredId = id;
    this.targetId = id;
    document.documentElement.classList.toggle(HIDE_CLASS, this.nativeHidden);
    this.sink.onTracks(this.tracks.map(toInfo), id);
    this.sink.onCues(cues);
    this.sink.onStatus({ code: 'ready', detail: info.kind === 'asr' ? 'автоматические субтитры' : undefined });
  }

  /** Last resort: read the caption lines the player renders. No timestamps, so no look-ahead. */
  private startLiveFallback(id: string): void {
    const container = this.playerEl?.querySelector<HTMLElement>('.ytp-caption-window-container');
    if (!container || !this.sink) {
      this.sink?.onStatus({ code: 'blocked', detail: 'Субтитры есть, но плеер не отдал их текст.' });
      return;
    }
    const explain = (): void => {
      this.sink?.onStatus({
        code: 'blocked',
        detail: this.emptyAnswer
          ? 'YouTube ответил на запрос субтитров пустым файлом. Так бывает при блокировщиках рекламы и в браузерах под управлением автоматизации. Включите субтитры кнопкой плеера или обновите страницу.'
          : 'Плеер не отдал текст субтитров. Включите субтитры кнопкой плеера или обновите страницу.',
      });
    };
    let last = '';
    let seen = false;
    const read = (): void => {
      const text = normalizeCueText(
        Array.from(container.querySelectorAll('.ytp-caption-segment'))
          .map((n) => n.textContent ?? '')
          .join(' '),
      );
      if (text === last) return;
      last = text;
      if (text.length > 0 && !seen) {
        seen = true;
        this.sink?.onStatus({ code: 'ready', detail: 'текст читается с экрана, без перевода наперёд' });
      }
      this.sink?.onLiveLine(text.length > 0 ? text : null);
    };
    this.liveWatcher?.disconnect();
    this.liveWatcher = new MutationObserver(read);
    this.liveWatcher.observe(container, { childList: true, subtree: true, characterData: true });
    this.deliveredId = id;
    document.documentElement.classList.toggle(HIDE_CLASS, this.nativeHidden);
    this.sink.onTracks(this.tracks.map(toInfo), id);
    this.sink.onStatus({ code: 'waiting-captions', detail: 'жду строки субтитров на экране' });
    read();
    // Nothing on screen either: say so instead of waiting silently.
    clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => {
      if (!seen) explain();
    }, 6000);
  }
}

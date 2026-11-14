// Netflix adapter (isolated world). Works with src/inject/netflix-main.ts, which passes on the
// subtitle track list from the player's playback manifest.
//
// Path 1: the German text file of the track (WebVTT or TTML) is downloaded through the
// background worker and parsed: full timeline, translation ahead of playback.
// Path 2 (fallback): the line Netflix draws on screen (.player-timedtext) is read as it appears.
// The video stream is never touched.
import type { ContentResponse } from '../../shared/messages.ts';
import type { AdapterStatus, TrackInfo } from '../../shared/types';
import { isNetflixManifest, type NetflixManifest, type NetflixTrack } from '../../inject/netflix-manifest.ts';
import { GermanCaptionReader } from './dom-captions.ts';
import { parseSubtitleFile } from './timed-text.ts';
import { looksGerman, type AdapterSink, type SubtitleAdapter } from './types.ts';

const CHANNEL = 'mitlesen';
const HIDE_CLASS = 'mitlesen-nf-hidden';
/** Without a manifest after this long, read the captions from the screen. */
const MANIFEST_WAIT_MS = 8000;

function watchIdOf(path: string): string | null {
  return /\/watch\/(\d+)/.exec(path)?.[1] ?? null;
}

function toInfo(t: NetflixTrack): TrackInfo {
  const cc = /closed|cc|sdh/i.test(t.kind);
  return {
    id: t.id,
    language: t.language,
    label: `${t.label}${t.forced ? ' (только надписи)' : cc ? ' (для слабослышащих)' : ''}`,
    kind: 'manual',
    isGerman: looksGerman(t.language, t.label),
  };
}

export class NetflixAdapter implements SubtitleAdapter {
  readonly id = 'netflix';

  private sink: AdapterSink | null = null;
  private video: HTMLVideoElement | null = null;
  private watchId: string | null = null;
  /** Manifests with their arrival time. */
  private manifests: { m: NetflixManifest; at: number }[] = [];
  private resetAt = 0;
  private locateFrame = 0;
  private manifest: NetflixManifest | null = null;
  private userChoice: string | null = null;
  private loadedId: string | null = null;
  private loadingId: string | null = null;
  private loading = 0;
  private style: HTMLStyleElement | null = null;
  private nativeHidden = false;
  private finder: MutationObserver | null = null;
  private chromeWatcher: MutationObserver | null = null;
  private chromeFrame = 0;
  private pathTimer: ReturnType<typeof setInterval> | undefined;
  private waitTimer: ReturnType<typeof setTimeout> | undefined;
  private reader: GermanCaptionReader | null = null;
  private seq = 0;

  start(sink: AdapterSink): void {
    this.sink = sink;
    window.addEventListener('message', this.onMessage);
    this.style = document.createElement('style');
    this.style.textContent = `html.${HIDE_CLASS} .player-timedtext{opacity:0!important}`;
    (document.head ?? document.documentElement).append(this.style);
    sink.onStatus({ code: 'searching' });
    // Netflix is a single-page app: /browse → /watch/<id> → next episode without reloads.
    this.watchId = watchIdOf(location.pathname);
    this.pathTimer = setInterval(() => {
      const id = watchIdOf(location.pathname);
      if (id !== this.watchId) {
        this.watchId = id;
        this.resetTitle();
        this.locateVideo();
      }
    }, 1000);
    this.finder = new MutationObserver(() => {
      if (!this.locateFrame) this.locateFrame = requestAnimationFrame(() => {
        this.locateFrame = 0;
        this.locateVideo();
      });
    });
    this.finder.observe(document.documentElement, { childList: true, subtree: true });
    this.locateVideo();
    window.postMessage({ channel: CHANNEL, from: 'content', type: 'nf-list', id: ++this.seq }, location.origin);
  }

  stop(): void {
    window.removeEventListener('message', this.onMessage);
    this.finder?.disconnect();
    this.chromeWatcher?.disconnect();
    cancelAnimationFrame(this.chromeFrame);
    cancelAnimationFrame(this.locateFrame);
    clearInterval(this.pathTimer);
    clearTimeout(this.waitTimer);
    this.stopReader();
    document.documentElement.classList.remove(HIDE_CLASS);
    this.style?.remove();
    this.sink = null;
  }

  selectTrack(id: string): void {
    this.userChoice = id;
    this.loadedId = null;
    this.loadingId = null;
    this.choose();
  }

  setNativeHidden(hidden: boolean): void {
    this.nativeHidden = hidden;
    this.updateHidden();
    this.reader?.setHidden(hidden);
  }

  private updateHidden(): void {
    document.documentElement.classList.toggle(HIDE_CLASS, this.nativeHidden && this.loadedId !== null);
  }

  // ── video ──

  private locateVideo(): void {
    // Only the player page counts; trailers on /browse autoplay without subtitles.
    const videos = this.watchId ? Array.from(document.querySelectorAll('video')) : [];
    const video = videos.sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0] ?? null;
    if (video === this.video) return;
    this.video = video;
    if (!video) {
      this.sink?.onVideo(null);
      this.sink?.onStatus({ code: 'no-video' });
      return;
    }
    this.sink?.onVideo({ container: video.parentElement ?? document.body, video, mode: 'fixed' });
    this.watchControls();
    this.choose();
  }

  /** The control bar appears on mouse movement; keep the subtitles above it. */
  private watchControls(): void {
    this.chromeWatcher?.disconnect();
    const root = this.video?.closest<HTMLElement>('.watch-video') ?? document.body;
    let last = -1;
    const update = (): void => {
      this.chromeFrame = 0;
      const bar = root.querySelector<HTMLElement>('.watch-video--bottom-controls-container, [data-uia="controls-standard"]');
      const inset = bar && bar.offsetHeight > 0 ? bar.offsetHeight + 8 : 0;
      if (inset !== last) {
        last = inset;
        this.sink?.onBottomInset(inset);
      }
    };
    this.chromeWatcher = new MutationObserver(() => {
      if (!this.chromeFrame) this.chromeFrame = requestAnimationFrame(update);
    });
    this.chromeWatcher.observe(root, { childList: true, subtree: true });
    update();
  }

  // ── manifests from the page world ──

  private readonly onMessage = (event: MessageEvent): void => {
    if (event.source !== window || event.origin !== location.origin) return;
    const data = event.data as { channel?: string; from?: string; type?: string; manifest?: unknown; manifests?: unknown } | null;
    if (!data || data.channel !== CHANNEL || data.from !== 'main') return;
    if (data.type === 'nf-manifest') this.addManifest(data.manifest);
    else if (data.type === 'nf-manifests' && Array.isArray(data.manifests)) data.manifests.slice(-8).forEach((m) => this.addManifest(m));
    else if (data.type === 'hello') window.postMessage({ channel: CHANNEL, from: 'content', type: 'nf-list', id: ++this.seq }, location.origin);
  };

  private addManifest(value: unknown): void {
    if (!isNetflixManifest(value)) return;
    if (this.manifests.some(({ m }) => m.movieId === value.movieId && m.tracks.length === value.tracks.length)) return;
    this.manifests.push({ m: value, at: Date.now() });
    if (this.manifests.length > 8) this.manifests.shift();
    this.choose();
  }

  private resetTitle(): void {
    this.resetAt = Date.now();
    this.manifest = null;
    this.loadedId = null;
    this.loadingId = null;
    this.userChoice = null;
    this.loading++;
    this.stopReader();
    this.updateHidden();
    this.sink?.onCues([]);
    this.sink?.onTracks([], null);
    this.sink?.onStatus({ code: 'searching' });
    this.choose();
  }

  // ── tracks ──

  private currentManifest(): NetflixManifest | null {
    // The manifest of the title in the address bar (for episodes the ids match as well); failing that,
    // the latest one that arrived around the last navigation (the player asks before the address changes).
    const exact = this.manifests.filter(({ m }) => m.movieId !== null && m.movieId === this.watchId).at(-1);
    const recent = this.manifests.filter(({ at }) => at >= this.resetAt - 5000).at(-1);
    return (exact ?? recent)?.m ?? null;
  }

  private choose(): void {
    if (!this.sink || !this.video) return;
    const manifest = this.currentManifest();
    if (!manifest) {
      this.sink.onStatus({ code: 'waiting-captions', detail: 'жду список субтитров от плеера Netflix' });
      clearTimeout(this.waitTimer);
      this.waitTimer = setTimeout(() => {
        if (!this.currentManifest()) {
          this.startReader({
            code: 'waiting-captions',
            detail: 'Список субтитров Netflix не получен (обычно помогает обновить страницу с фильмом). Пока читаю строки с экрана: включите немецкие субтитры в плеере Netflix.',
          });
        }
      }, MANIFEST_WAIT_MS);
      return;
    }
    clearTimeout(this.waitTimer);
    this.manifest = manifest;
    const usable = manifest.tracks.filter((t) => !t.imageOnly);
    const infos = manifest.tracks.map(toInfo);
    const german = usable.filter((t) => looksGerman(t.language, t.label));
    const chosen =
      usable.find((t) => t.id === this.userChoice) ??
      german.find((t) => !t.forced && !/closed/i.test(t.kind)) ??
      german.find((t) => !t.forced) ??
      german[0];
    this.sink.onTracks(infos, this.loadedId ?? chosen?.id ?? null);
    if (!chosen) {
      const imageGerman = manifest.tracks.some((t) => t.imageOnly && looksGerman(t.language, t.label));
      this.sink.onStatus({
        code: imageGerman ? 'blocked' : 'no-german',
        detail: imageGerman
          ? 'Немецкие субтитры у этого фильма только картинками; текст из них не прочитать.'
          : `Немецких субтитров у этого фильма нет. Доступны: ${[...new Set(manifest.tracks.map((t) => t.label))].join(', ')}.`,
      });
      return;
    }
    if (chosen.id === this.loadedId || chosen.id === this.loadingId) return;
    void this.load(chosen);
  }

  private async load(track: NetflixTrack): Promise<void> {
    const token = ++this.loading;
    this.loadingId = track.id;
    this.sink?.onStatus({ code: 'waiting-captions', detail: track.label });
    let lastError = 'файл субтитров не загрузился';
    for (const file of track.files.slice(0, 6)) {
      let reply: ContentResponse | undefined;
      try {
        reply = (await chrome.runtime.sendMessage({ t: 'fetch-subtitles', url: file.url })) as ContentResponse | undefined;
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
        continue;
      }
      if (token !== this.loading || !this.sink) return;
      if (!reply?.ok) {
        lastError = reply ? reply.error.message : 'нет ответа от расширения';
        continue;
      }
      const cues = parseSubtitleFile(reply.text);
      if (cues.length === 0) {
        lastError = `в файле (${file.profile}) нет строк`;
        continue;
      }
      this.stopReader();
      this.loadingId = null;
      this.loadedId = track.id;
      this.updateHidden();
      this.sink.onTracks(this.manifest?.tracks.map(toInfo) ?? [], track.id);
      this.sink.onCues(cues);
      this.sink.onStatus({ code: 'ready', detail: track.label });
      return;
    }
    if (token !== this.loading || !this.sink) return;
    this.loadingId = null;
    this.startReader({ code: 'blocked', detail: `Не удалось загрузить немецкие субтитры Netflix: ${lastError}. Читаю их с экрана, если они включены в плеере.` });
  }

  // ── fallback: the caption Netflix draws ──

  /** `status` is shown until German lines are seen on screen. */
  private startReader(status: AdapterStatus): void {
    if (!this.video || !this.sink) return;
    if (this.reader) {
      if (!this.reader.german) this.sink.onStatus(status);
      return;
    }
    const root = this.video.closest<HTMLElement>('.watch-video') ?? undefined;
    this.reader = new GermanCaptionReader(
      this.video,
      {
        line: (text) => this.sink?.onLiveLine(text),
        language: (verdict) =>
          this.sink?.onStatus(
            verdict === 'german'
              ? { code: 'ready', detail: 'текст читается с экрана, без перевода наперёд' }
              : { code: 'no-german', detail: 'На экране не немецкие субтитры. Выберите немецкие в меню субтитров Netflix.' },
          ),
      },
      { selectors: ['.player-timedtext'], root },
    );
    this.reader.setHidden(this.nativeHidden);
    this.reader.start();
    this.sink.onStatus(status);
  }

  private stopReader(): void {
    this.reader?.stop();
    this.reader = null;
  }
}

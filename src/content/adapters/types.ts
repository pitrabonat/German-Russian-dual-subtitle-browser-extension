// Contract between the page-specific subtitle sources and the rest of the content script.
// A new website is supported by writing one adapter; translation, grammar and rendering
// never need to change.
import type { AdapterStatus, Cue, TrackInfo } from '../../shared/types';

export interface OverlayMount {
  /** Element the overlay is attached to. */
  container: HTMLElement;
  video: HTMLVideoElement;
  /**
   * `inside`: the container wraps the video (for example the YouTube player); the overlay
   * fills it and follows it into fullscreen for free.
   * `fixed`: there is no such wrapper; the overlay is positioned over the video rectangle.
   */
  mode: 'inside' | 'fixed';
}

export interface AdapterSink {
  /** A video appeared, changed or went away. */
  onVideo(mount: OverlayMount | null): void;
  /** The list of subtitle tracks or the active track changed. */
  onTracks(tracks: TrackInfo[], activeTrackId: string | null): void;
  /** Timed cues of the active track. May be called again when more cues arrive. */
  onCues(cues: Cue[]): void;
  /**
   * A subtitle line seen on the page without timing information (fallback when the track
   * itself cannot be read). `null` means the line disappeared.
   */
  onLiveLine(text: string | null): void;
  onStatus(status: AdapterStatus): void;
  /** Extra space to keep free at the bottom of the video, in pixels (player controls). */
  onBottomInset(pixels: number): void;
  /** True while the video shows something the cues do not belong to (an advertisement). */
  onSuspend(suspended: boolean): void;
}

export interface SubtitleAdapter {
  readonly id: string;
  start(sink: AdapterSink): void;
  stop(): void;
  /** Switches to another subtitle track by its TrackInfo id. */
  selectTrack(trackId: string): void;
  /** Hides or restores the site's own subtitle rendering. */
  setNativeHidden(hidden: boolean): void;
}

const GERMAN_LABEL = /\b(deutsch|german|allemand|немецк)/i;

/** Decides whether a track is German from its language tag or, failing that, its label. */
export function looksGerman(language: string, label: string): boolean {
  const lang = language.trim().toLowerCase();
  if (lang) return lang === 'de' || lang.startsWith('de-') || lang === 'deu' || lang === 'ger';
  return GERMAN_LABEL.test(label);
}

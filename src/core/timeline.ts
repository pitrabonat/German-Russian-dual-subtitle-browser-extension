// Cue lookup by playback time.
import type { Cue } from '../shared/types';

export class Timeline {
  readonly cues: readonly Cue[];

  constructor(cues: readonly Cue[]) {
    this.cues = [...cues].sort((a, b) => a.start - b.start).map((cue, index) => ({ ...cue, index }));
  }

  get length(): number {
    return this.cues.length;
  }

  /** Index of the last cue that starts at or before `time`, or -1. */
  private lastStartedAt(time: number): number {
    let lo = 0;
    let hi = this.cues.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.cues[mid]!.start <= time) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return found;
  }

  /** The cue on screen at `time`. With overlapping cues the one that started last wins. */
  at(time: number): Cue | null {
    for (let i = this.lastStartedAt(time); i >= 0; i--) {
      const cue = this.cues[i]!;
      if (cue.end > time) return cue;
      // Cues are sorted by start; a few earlier ones may still overlap, then we can stop.
      if (time - cue.start > 30) break;
    }
    return null;
  }

  /** Index of the first cue that ends after `time`: the current cue or the next one. */
  indexFrom(time: number): number {
    let i = Math.max(0, this.lastStartedAt(time));
    while (i > 0 && this.cues[i - 1]!.end > time) i--;
    while (i < this.cues.length && this.cues[i]!.end <= time) i++;
    return i;
  }

  /** Time of the next cue start or end after `time`, or null when nothing follows. */
  nextBoundary(time: number): number | null {
    let best: number | null = null;
    const consider = (t: number): void => {
      if (t > time + 1e-3 && (best === null || t < best)) best = t;
    };
    const started = this.lastStartedAt(time);
    for (let i = Math.max(0, started - 3); i <= Math.min(this.cues.length - 1, started + 1); i++) {
      const cue = this.cues[i]!;
      consider(cue.start);
      consider(cue.end);
    }
    return best;
  }
}

// Latency bookkeeping for translation providers and the grammar engine.
import type { LatencyStats, ProviderId, ProviderMetrics } from '../../shared/types';

/** Sliding window of the most recent latency samples. */
export class LatencyWindow {
  private readonly samples: number[] = [];
  private next = 0;
  private total = 0;

  constructor(private readonly capacity = 400) {}

  add(ms: number): void {
    if (this.samples.length < this.capacity) this.samples.push(ms);
    else this.samples[this.next] = ms;
    this.next = (this.next + 1) % this.capacity;
    this.total++;
  }

  stats(): LatencyStats {
    if (this.samples.length === 0) return { count: 0, avg: 0, median: 0, p95: 0 };
    const sorted = [...this.samples].sort((a, b) => a - b);
    const at = (q: number): number => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * q) - 1))]!;
    const avg = sorted.reduce((sum, v) => sum + v, 0) / sorted.length;
    return { count: this.total, avg: Math.round(avg), median: Math.round(at(0.5)), p95: Math.round(at(0.95)) };
  }
}

interface ProviderCounters {
  requests: number;
  errors: number;
  latency: LatencyWindow;
  initMs?: number;
}

export class MetricsRegistry {
  private readonly providers = new Map<ProviderId, ProviderCounters>();

  private entry(id: ProviderId): ProviderCounters {
    let counters = this.providers.get(id);
    if (!counters) {
      counters = { requests: 0, errors: 0, latency: new LatencyWindow() };
      this.providers.set(id, counters);
    }
    return counters;
  }

  /** Records one translated sentence. `ms` is the share of the batch time that belongs to it. */
  success(id: ProviderId, ms: number): void {
    const counters = this.entry(id);
    counters.requests++;
    counters.latency.add(ms);
  }

  failure(id: ProviderId): void {
    const counters = this.entry(id);
    counters.requests++;
    counters.errors++;
  }

  init(id: ProviderId, ms: number): void {
    const counters = this.entry(id);
    if (counters.initMs === undefined) counters.initMs = Math.round(ms);
  }

  snapshot(): ProviderMetrics[] {
    return [...this.providers.entries()].map(([id, c]) => ({
      id,
      requests: c.requests,
      errors: c.errors,
      latency: c.latency.stats(),
      initMs: c.initMs,
    }));
  }
}

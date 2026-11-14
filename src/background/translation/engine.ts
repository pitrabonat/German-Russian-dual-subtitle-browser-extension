// Translation engine: cache lookup, de-duplication, priority queues, cancellation and fallback.
//
// Each provider has its own lane that runs one call at a time; lanes of different providers
// run concurrently (the LLM works on the GPU while the NMT model works on the CPU).
//
// Two-tier translation: when the preferred provider is slow (an LLM) and a fast one is also
// usable, a subtitle that is on screen right now is first answered by the fast provider
// (marked provisional) and replaced as soon as the preferred provider delivers.
import type { MitlesenError, Priority, ProviderId, TranslateItem } from '../../shared/types';
import type { ServerMessage } from '../../shared/messages';
import { makeError, toError } from '../../shared/messages.ts';
import { hashString } from '../../shared/text.ts';
import type { CacheStore } from '../cache/store';
import type { MetricsRegistry } from './metrics';
import { looksRussian } from './prompt.ts';
import type { TranslateRequest, TranslationProvider } from './provider';

/** Bump to invalidate every cached translation. */
export const CACHE_SCHEMA = 't1';

export type Reply = (message: ServerMessage) => void;

interface WaiterState {
  clientId: string;
  key: string;
  reply: Reply;
  finalSent: boolean;
  jobs: Set<Job>;
}

interface Job {
  id: string;
  request: TranslateRequest;
  priority: Priority;
  seq: number;
  /** Providers still to try, in order of preference. */
  chain: ProviderId[];
  /** Fast first answer for a slow preferred provider; dropped silently when it fails. */
  provisional: boolean;
  waiters: Set<WaiterState>;
  running: boolean;
  lastError?: MitlesenError;
}

type Plan =
  | { kind: 'unavailable' }
  | { kind: 'hit'; text: string; provider: ProviderId }
  | { kind: 'miss'; request: TranslateRequest; usable: TranslationProvider[]; draft?: { provider: TranslationProvider; text: string | undefined } };

interface Lane {
  active: { jobs: Job[]; controller: AbortController; preempted: boolean } | null;
}

export interface EngineDeps {
  /** Providers in order of preference for the current settings. */
  chain: () => TranslationProvider[];
  cache: CacheStore<string>;
  metrics: MetricsRegistry;
  now?: () => number;
}

export function cacheKey(provider: TranslationProvider, request: TranslateRequest): string {
  const material = provider.usesContext ? [request.text, ...request.before, '\u0001', ...request.after].join('\n') : request.text;
  return `${CACHE_SCHEMA}|${provider.id}|${provider.cacheTag()}|${hashString(material)}`;
}

/** Rejects empty output, echoes of the German input and runaway generations. */
export function plausibleTranslation(source: string, output: string): boolean {
  const text = output.trim();
  if (text.length === 0) return false;
  if (text.length > Math.max(60, source.length * 6)) return false;
  return looksRussian(text);
}

export class TranslationEngine {
  private readonly jobs = new Map<string, Job>();
  private readonly waiters = new Map<string, WaiterState>();
  private readonly lanes = new Map<ProviderId, Lane>();
  private seq = 0;
  private readonly now: () => number;

  constructor(private readonly deps: EngineDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  /** Accepts translation requests from one client (a tab). Results arrive through `reply`. */
  submit(clientId: string, items: TranslateItem[], reply: Reply): void {
    // Cache lookups first, for all items; then everything is queued in one go, so that items
    // of one message can share a batch and the urgent one is seen before work starts.
    void Promise.all(items.map((item) => this.plan(item)))
      .then((plans) => {
        plans.forEach((plan, i) => this.apply(clientId, items[i]!, reply, plan));
        this.pump();
      })
      .catch((e) => {
        for (const item of items) reply({ t: 'translate-error', key: item.key, error: toError(e) });
      });
  }

  /** Drops every request of the client except the ones listed in `keep`. */
  cancel(clientId: string, keep: ReadonlySet<string> = new Set()): void {
    for (const [id, waiter] of this.waiters) {
      if (waiter.clientId !== clientId || keep.has(waiter.key)) continue;
      this.detach(waiter);
      this.waiters.delete(id);
    }
    this.pump();
  }

  stats(): { waiting: number; inFlight: number } {
    let waiting = 0;
    let inFlight = 0;
    for (const job of this.jobs.values()) {
      if (job.running) inFlight++;
      else waiting++;
    }
    return { waiting, inFlight };
  }

  /** Call after provider availability changed (settings, health check) to re-route waiting jobs. */
  kick(): void {
    this.pump();
  }

  /** Decides what has to happen for one item: nothing usable, a cache hit, or work to queue. */
  private async plan(item: TranslateItem): Promise<Plan> {
    const request: TranslateRequest = { text: item.text, before: item.before, after: item.after };
    const usable = this.deps.chain().filter((p) => p.usable(this.now()));
    const preferred = usable[0];
    if (!preferred) return { kind: 'unavailable' };
    const cached = await this.deps.cache.get(cacheKey(preferred, request));
    if (cached !== undefined) return { kind: 'hit', text: cached, provider: preferred.id };
    // A slow preferred provider gets a fast first draft for the line that is on screen.
    const fast = item.priority === 0 && preferred.speed === 'slow' ? usable.find((p) => p.speed === 'fast') : undefined;
    const draft = fast ? { provider: fast, text: await this.deps.cache.get(cacheKey(fast, request)) } : undefined;
    return { kind: 'miss', request, usable, draft };
  }

  private apply(clientId: string, item: TranslateItem, reply: Reply, plan: Plan): void {
    if (plan.kind === 'unavailable') {
      reply({ t: 'translate-error', key: item.key, error: this.unavailable() });
      return;
    }
    if (plan.kind === 'hit') {
      reply({ t: 'translated', result: { key: item.key, text: plan.text, provider: plan.provider, cached: true, ms: 0 } });
      return;
    }
    const waiterId = `${clientId}|${item.key}`;
    let waiter = this.waiters.get(waiterId);
    if (!waiter) {
      waiter = { clientId, key: item.key, reply, finalSent: false, jobs: new Set() };
      this.waiters.set(waiterId, waiter);
    } else {
      waiter.reply = reply;
    }
    this.enqueue(plan.request, item.priority, plan.usable, waiter, false);
    if (!plan.draft) return;
    if (plan.draft.text !== undefined) {
      reply({ t: 'translated', result: { key: item.key, text: plan.draft.text, provider: plan.draft.provider.id, cached: true, ms: 0, provisional: true } });
    } else {
      this.enqueue(plan.request, 0, [plan.draft.provider], waiter, true);
    }
  }

  private enqueue(request: TranslateRequest, priority: Priority, chain: TranslationProvider[], waiter: WaiterState, provisional: boolean): void {
    const first = chain[0]!;
    const id = `${provisional ? 'q' : 'm'}|${hashString([request.text, ...(first.usesContext ? [...request.before, '\u0001', ...request.after] : [])].join('\n'))}`;
    let job = this.jobs.get(id);
    if (!job) {
      job = { id, request, priority, seq: this.seq++, chain: chain.map((p) => p.id), provisional, waiters: new Set(), running: false };
      this.jobs.set(id, job);
    } else if (priority < job.priority) {
      job.priority = priority;
    }
    job.waiters.add(waiter);
    waiter.jobs.add(job);
  }

  private detach(waiter: WaiterState): void {
    for (const job of waiter.jobs) {
      job.waiters.delete(waiter);
      if (job.waiters.size > 0) continue;
      if (!job.running) {
        this.jobs.delete(job.id);
        continue;
      }
      // Nobody waits for the running call any more: stop it if every job in the batch is orphaned.
      for (const [providerId, lane] of this.lanes) {
        if (!lane.active?.jobs.includes(job)) continue;
        const provider = this.deps.chain().find((p) => p.id === providerId);
        if (provider?.abortable && lane.active.jobs.every((j) => j.waiters.size === 0)) lane.active.controller.abort();
      }
    }
    waiter.jobs.clear();
  }

  private lane(id: ProviderId): Lane {
    let lane = this.lanes.get(id);
    if (!lane) {
      lane = { active: null };
      this.lanes.set(id, lane);
    }
    return lane;
  }

  private unavailable(lastError?: MitlesenError): MitlesenError {
    if (lastError) return lastError;
    // The reason of the first provider in the chain is the one the user can act on.
    const reason = this.deps.chain().map((p) => p.status().error).find((e) => e !== undefined);
    return reason ?? makeError('no-provider', 'Сейчас нет доступного переводчика. Проверьте режим перевода в окне расширения.');
  }

  /** The provider a waiting job should go to: the first one in its chain that is usable now. */
  private target(job: Job, usableIds: ReadonlySet<ProviderId>): ProviderId | undefined {
    return job.chain.find((id) => usableIds.has(id));
  }

  private pump(): void {
    const chain = this.deps.chain();
    const now = this.now();
    const usableIds = new Set(chain.filter((p) => p.usable(now)).map((p) => p.id));

    // Jobs that no usable provider can take fail now instead of waiting forever.
    for (const job of [...this.jobs.values()]) {
      if (!job.running && this.target(job, usableIds) === undefined) this.settleFailure(job, this.unavailable(job.lastError));
    }

    for (const provider of chain) {
      if (!usableIds.has(provider.id)) continue;
      const lane = this.lane(provider.id);
      const queued = [...this.jobs.values()]
        .filter((job) => !job.running && this.target(job, usableIds) === provider.id)
        .sort((a, b) => a.priority - b.priority || a.seq - b.seq);
      const head = queued[0];
      if (!head) continue;

      if (lane.active) {
        // Background preloading must not delay the subtitle that is on screen.
        const busyWithBackground = lane.active.jobs.every((j) => j.priority === 2);
        if (head.priority === 0 && busyWithBackground && provider.abortable && !lane.active.preempted) {
          lane.active.preempted = true;
          lane.active.controller.abort();
        }
        continue;
      }
      const size = head.priority === 0 ? 1 : provider.batchSize;
      const batch = queued.filter((job) => (head.priority === 0 ? job === head : job.priority >= 1)).slice(0, size);
      void this.run(lane, provider, batch);
    }
  }

  private async run(lane: Lane, provider: TranslationProvider, batch: Job[]): Promise<void> {
    const active = { jobs: batch, controller: new AbortController(), preempted: false };
    lane.active = active;
    for (const job of batch) job.running = true;
    const started = this.now();
    try {
      const outputs = await provider.translate(batch.map((job) => job.request), active.controller.signal);
      const perItem = (this.now() - started) / batch.length;
      batch.forEach((job, i) => {
        job.running = false;
        const text = outputs[i]?.trim() ?? '';
        if (plausibleTranslation(job.request.text, text)) {
          this.deps.metrics.success(provider.id, perItem);
          void this.deps.cache.set(cacheKey(provider, job.request), text);
          this.settleSuccess(job, text, provider.id, perItem);
        } else {
          this.deps.metrics.failure(provider.id);
          this.retryElsewhere(job, provider.id, makeError('bad-response', `${provider.id} returned an unusable translation.`));
        }
      });
    } catch (e) {
      const error = toError(e);
      const interrupted = active.preempted || error.code === 'cancelled';
      for (const job of batch) {
        job.running = false;
        if (interrupted) {
          // Not the provider's fault: the job simply returns to the queue (or goes away with its waiters).
          if (job.waiters.size === 0) this.jobs.delete(job.id);
        } else {
          this.deps.metrics.failure(provider.id);
          this.retryElsewhere(job, provider.id, error);
        }
      }
    } finally {
      lane.active = null;
      this.pump();
    }
  }

  private retryElsewhere(job: Job, failed: ProviderId, error: MitlesenError): void {
    job.chain = job.chain.filter((id) => id !== failed);
    job.lastError = error;
    if (job.chain.length === 0) this.settleFailure(job, error);
  }

  private settleSuccess(job: Job, text: string, provider: ProviderId, ms: number): void {
    this.jobs.delete(job.id);
    for (const waiter of job.waiters) {
      waiter.jobs.delete(job);
      if (waiter.finalSent) continue;
      waiter.reply({
        t: 'translated',
        result: { key: waiter.key, text, provider, cached: false, ms: Math.round(ms), ...(job.provisional ? { provisional: true } : {}) },
      });
      if (!job.provisional) {
        waiter.finalSent = true;
        this.detach(waiter);
        this.waiters.delete(`${waiter.clientId}|${waiter.key}`);
      }
    }
  }

  private settleFailure(job: Job, error: MitlesenError): void {
    this.jobs.delete(job.id);
    for (const waiter of job.waiters) {
      waiter.jobs.delete(job);
      // A failed provisional attempt is not an error for the client: the preferred provider is still working.
      if (job.provisional || waiter.finalSent) continue;
      waiter.reply({ t: 'translate-error', key: waiter.key, error });
      this.detach(waiter);
      this.waiters.delete(`${waiter.clientId}|${waiter.key}`);
    }
  }
}

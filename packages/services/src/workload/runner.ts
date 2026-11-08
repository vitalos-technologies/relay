// Workload runner (V3.1 brief §6): admission control + measurement for every background item a worker runs.
//  - Class gate: per-process concurrency cap + per-workspace cap per class (FIFO, no head-of-line blocking across
//    workspaces). A waiter that exceeds maxSlotWaitMs runs anyway (counted as overflow) so a job is never held past
//    pg-boss's expiry (which would re-deliver it).
//  - Backpressure: classes that defer wait (bounded by maxDeferMs) while publishing is under pressure.
//  - Reserved publishing capacity: bulk classes run inside runWithPool(bulkPool) so every getPool() call they make uses
//    a separate, smaller pool; the main pool stays available to the claim loops and publishing.
//  - Metrics: dispatch delay (eligible → started), local wait, processing time and provider time (time inside provider
//    adapters, publishing only) are recorded per item into workload_samples (buffered; migration 020).
// Nothing here changes idempotency, fencing or Unknown handling: it only decides WHEN an item starts.
import { AsyncLocalStorage } from 'node:async_hooks';
import type { PublishingAdapter, Provider } from '@social-lite/core';
import type { WorkloadClass, WorkloadClassPolicy } from '@social-lite/core/contracts/v31-perf';
import { getPool, maybeOne, runWithPool, type Pool, type Queryable } from '@social-lite/db';
import type { EngineDeps } from '../engine/process.js';
import { log } from '../log.js';
import { PRESSURE_DEFAULTS, workloadPolicies } from './policy.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ provider time
const providerClock = new AsyncLocalStorage<{ ms: number }>();

/** Wrap engine deps so time spent inside provider adapter calls is attributed to the item being processed. */
export function instrumentEngineDeps(deps: EngineDeps): EngineDeps {
  return {
    ...deps,
    adapterFor(provider: Provider) {
      const a = deps.adapterFor(provider);
      return new Proxy(a, {
        get(target, prop, recv) {
          const v = Reflect.get(target, prop, recv) as unknown;
          if (typeof v !== 'function') return v;
          return (...args: unknown[]) => {
            const sink = providerClock.getStore();
            const t = performance.now();
            const out = (v as (...x: unknown[]) => unknown).apply(target, args);
            if (!sink) return out;
            if (out && typeof (out as Promise<unknown>).then === 'function') return (out as Promise<unknown>).finally(() => { sink.ms += performance.now() - t; });
            sink.ms += performance.now() - t;
            return out;
          };
        },
      }) as PublishingAdapter;
    },
  };
}

/** Run fn with a provider clock; returns its value and the time spent inside instrumented provider adapter calls. */
export async function withProviderClock<T>(fn: () => Promise<T>): Promise<{ value: T; providerMs: number }> {
  const clock = { ms: 0 };
  const value = await providerClock.run(clock, fn);
  return { value, providerMs: clock.ms };
}

// ------------------------------------------------------------------ class gate
export class ClassGate {
  running = 0;
  private perWs = new Map<string, number>();
  private waiters: Array<{ ws: string | null; wake: () => void }> = [];
  constructor(readonly max: number, readonly perWorkspace: number) {}

  get waiting(): number { return this.waiters.length; }

  private can(ws: string | null): boolean {
    return this.running < this.max && (!ws || (this.perWs.get(ws) ?? 0) < this.perWorkspace);
  }

  private take(ws: string | null): void {
    this.running++;
    if (ws) this.perWs.set(ws, (this.perWs.get(ws) ?? 0) + 1);
  }

  /** Resolves when a slot is held. Returns true when it gave up waiting after timeoutMs (ran as overflow). */
  async acquire(ws: string | null, timeoutMs: number): Promise<boolean> {
    if (this.can(ws)) { this.take(ws); return false; }
    return new Promise<boolean>((resolve) => {
      const w = { ws, wake: () => { clearTimeout(timer); this.take(ws); resolve(false); } };
      const timer = setTimeout(() => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) this.waiters.splice(i, 1);
        this.take(ws);
        resolve(true);
      }, timeoutMs);
      this.waiters.push(w);
    });
  }

  release(ws: string | null): void {
    this.running = Math.max(0, this.running - 1);
    if (ws) {
      const n = (this.perWs.get(ws) ?? 1) - 1;
      if (n <= 0) this.perWs.delete(ws); else this.perWs.set(ws, n);
    }
    for (let i = 0; i < this.waiters.length;) {
      const w = this.waiters[i]!;
      if (this.can(w.ws)) { this.waiters.splice(i, 1); w.wake(); continue; }
      i++;
    }
  }
}

// ------------------------------------------------------------------ publishing pressure
export interface PressureState { active: boolean; reason: string | null }
export interface PressureSource { check(): Promise<PressureState> }

/**
 * Publishing is under pressure when every publishing slot of this worker is busy, or when claimable due work (not
 * throttled, provider circuit closed, no live lease) has waited longer than dueAgeSeconds. Cached for cacheMs.
 */
export function publishingPressure(o: { slots: number; busy: () => number; dueAgeSeconds?: number; cacheMs?: number; db?: () => Queryable }): PressureSource {
  const maxAge = o.dueAgeSeconds ?? PRESSURE_DEFAULTS.dueAgeSeconds;
  const cacheMs = o.cacheMs ?? 1000;
  let cached: { at: number; state: PressureState } | null = null;
  return {
    async check() {
      if (o.busy() >= o.slots) return { active: true, reason: 'publishing_slots_busy' };
      if (cached && Date.now() - cached.at < cacheMs) return cached.state;
      const r = await maybeOne<{ age: number | null }>((o.db ?? getPool)(),
        `SELECT extract(epoch FROM now() - min(d.next_attempt_at))::float8 AS age
           FROM deliveries d JOIN connections c ON c.id = d.connection_id LEFT JOIN provider_circuits pc ON pc.provider = d.provider
          WHERE d.state IN ('scheduled','retry_wait') AND d.next_attempt_at <= now() AND d.lease_owner IS NULL
            AND (c.throttled_until IS NULL OR c.throttled_until <= now()) AND (pc.opened_until IS NULL OR pc.opened_until <= now())`);
      const age = r?.age ?? 0;
      const state = age > maxAge ? { active: true, reason: `due_work_waiting_${Math.round(age)}s` } : { active: false, reason: null };
      cached = { at: Date.now(), state };
      return state;
    },
  };
}

// ------------------------------------------------------------------ samples
export interface WorkloadSample {
  workload_class: WorkloadClass; queue: string | null; workspace_id: string | null; provider: string | null;
  eligible_at: Date; started_at: Date; finished_at: Date; local_wait_ms: number; deferred_ms: number; provider_ms: number | null;
  outcome: 'ok' | 'error'; overflow: boolean; worker_id: string;
}

/** Buffered writer for workload_samples (migration 020). Disabled (with one warning) when the table is missing. */
export class SampleRecorder {
  private buf: WorkloadSample[] = [];
  private enabled: boolean | null = null;
  private lastPurge = 0;
  dropped = 0;
  constructor(private readonly db: () => Queryable = getPool, private readonly max = 5000) {}

  add(s: WorkloadSample): void {
    if (this.enabled === false) return;
    if (this.buf.length >= this.max) { this.buf.shift(); this.dropped++; }
    this.buf.push(s);
  }

  get pending(): number { return this.buf.length; }

  async flush(): Promise<number> {
    if (this.enabled === null) {
      const r = await maybeOne<{ ok: boolean }>(this.db(), `SELECT to_regclass('public.workload_samples') IS NOT NULL AS ok`);
      this.enabled = !!r?.ok;
      if (!this.enabled) { log.warn('workload_samples_disabled', { reason: 'migration 020_v31_perf not applied' }); this.buf = []; }
    }
    if (!this.enabled || !this.buf.length) return 0;
    const rows = this.buf.splice(0, 1000);
    const col = <T>(f: (s: WorkloadSample) => T) => rows.map(f);
    await this.db().query(
      `INSERT INTO workload_samples(workload_class, queue, workspace_id, provider, eligible_at, started_at, finished_at, dispatch_delay_ms, local_wait_ms,
          deferred_ms, processing_ms, provider_ms, outcome, overflow, worker_id)
       SELECT c, q, w, p, e, s, f, greatest(0, round(extract(epoch FROM s - e) * 1000))::int, lw, dm, greatest(0, round(extract(epoch FROM f - s) * 1000))::int, pm, o, ov, wid
         FROM unnest($1::text[], $2::text[], $3::uuid[], $4::text[], $5::timestamptz[], $6::timestamptz[], $7::timestamptz[], $8::int[], $9::int[], $10::int[], $11::text[], $12::bool[], $13::text[])
              AS t(c, q, w, p, e, s, f, lw, dm, pm, o, ov, wid)
        WHERE w IS NULL OR EXISTS (SELECT 1 FROM workspaces x WHERE x.id = w)`,
      [col((s) => s.workload_class), col((s) => s.queue), col((s) => s.workspace_id), col((s) => s.provider), col((s) => s.eligible_at), col((s) => s.started_at),
        col((s) => s.finished_at), col((s) => Math.round(s.local_wait_ms)), col((s) => Math.round(s.deferred_ms)),
        col((s) => (s.provider_ms === null ? null : Math.round(s.provider_ms))), col((s) => s.outcome), col((s) => s.overflow), col((s) => s.worker_id)]);
    if (Date.now() - this.lastPurge > 3600_000) {
      this.lastPurge = Date.now();
      await this.db().query(`DELETE FROM workload_samples WHERE finished_at < now() - interval '7 days'`);
    }
    return rows.length;
  }
}

// ------------------------------------------------------------------ runner
export interface RunMeta {
  workspaceId?: string | null;
  /** When the item became eligible (job start_after/created, delivery next_attempt_at). Default: arrival. */
  eligibleAt?: Date | null;
  queue?: string | null;
  provider?: string | null;
}

export interface WorkloadRunnerOptions {
  workerId: string;
  /** Pool for bulk classes (null: same pool — e.g. tests). */
  bulkPool?: Pool | null;
  pressure?: PressureSource | null;
  recorder?: SampleRecorder | null;
  policies?: Record<WorkloadClass, WorkloadClassPolicy>;
  publishingSlots?: number;
  maxDeferMs?: number;
  maxSlotWaitMs?: number;
  /** Poll interval while deferring. */
  deferPollMs?: number;
}

export class WorkloadRunner {
  readonly policies: Record<WorkloadClass, WorkloadClassPolicy>;
  private gates = new Map<WorkloadClass, ClassGate>();
  private deferring = new Map<WorkloadClass, number>();
  publishingRunning = 0;

  constructor(private readonly o: WorkloadRunnerOptions) {
    this.policies = o.policies ?? workloadPolicies(process.env, o.publishingSlots);
    for (const p of Object.values(this.policies)) this.gates.set(p.class, new ClassGate(p.max_concurrent, p.per_workspace));
  }

  /** Run one bulk/background item of `cls` under its gate, backpressure and pool. Errors propagate unchanged. */
  async run<T>(cls: WorkloadClass, meta: RunMeta, fn: () => Promise<T>): Promise<T> {
    if (cls === 'publishing') return this.publishing(meta, fn);
    const policy = this.policies[cls];
    const arrived = Date.now();
    let deferred = 0;
    if (policy.defers_under_publishing_pressure && this.o.pressure) {
      const maxDefer = this.o.maxDeferMs ?? PRESSURE_DEFAULTS.maxDeferMs;
      this.deferring.set(cls, (this.deferring.get(cls) ?? 0) + 1);
      try {
        while (Date.now() - arrived < maxDefer && (await this.o.pressure.check().catch(() => ({ active: false, reason: null }))).active) {
          await sleep(this.o.deferPollMs ?? 500);
        }
      } finally { this.deferring.set(cls, (this.deferring.get(cls) ?? 1) - 1); }
      deferred = Date.now() - arrived;
    }
    const gate = this.gates.get(cls)!;
    const ws = meta.workspaceId ?? null;
    const overflow = await gate.acquire(ws, this.o.maxSlotWaitMs ?? PRESSURE_DEFAULTS.maxSlotWaitMs);
    const started = new Date();
    let outcome: 'ok' | 'error' = 'ok';
    try {
      const go = () => providerClock.run({ ms: 0 }, fn);
      return await (policy.pool === 'bulk' && this.o.bulkPool ? runWithPool(this.o.bulkPool, go) : go());
    } catch (err) {
      outcome = 'error';
      throw err;
    } finally {
      gate.release(ws);
      this.o.recorder?.add({
        workload_class: cls, queue: meta.queue ?? null, workspace_id: ws, provider: meta.provider ?? null, eligible_at: meta.eligibleAt ?? new Date(arrived),
        started_at: started, finished_at: new Date(), local_wait_ms: started.getTime() - arrived, deferred_ms: deferred, provider_ms: null, outcome, overflow,
        worker_id: this.o.workerId,
      });
    }
  }

  /** Publishing (claimed delivery / reconciliation): never gated or deferred; measured with provider time. */
  async publishing<T>(meta: RunMeta, fn: () => Promise<T>): Promise<T> {
    const started = new Date();
    const clock = { ms: 0 };
    let outcome: 'ok' | 'error' = 'ok';
    this.publishingRunning++;
    try {
      return await providerClock.run(clock, fn);
    } catch (err) {
      outcome = 'error';
      throw err;
    } finally {
      this.publishingRunning--;
      this.o.recorder?.add({
        workload_class: 'publishing', queue: meta.queue ?? 'deliveries', workspace_id: meta.workspaceId ?? null, provider: meta.provider ?? null,
        eligible_at: meta.eligibleAt && meta.eligibleAt < started ? meta.eligibleAt : started, started_at: started, finished_at: new Date(),
        local_wait_ms: 0, deferred_ms: 0, provider_ms: clock.ms, outcome, overflow: false, worker_id: this.o.workerId,
      });
    }
  }

  /** In-process view (worker /ready + heartbeat info). */
  snapshot(): Record<string, { running: number; waiting: number; deferring: number }> {
    const out: Record<string, { running: number; waiting: number; deferring: number }> = {};
    for (const [cls, g] of this.gates) out[cls] = { running: cls === 'publishing' ? this.publishingRunning : g.running, waiting: g.waiting, deferring: this.deferring.get(cls) ?? 0 };
    return out;
  }
}


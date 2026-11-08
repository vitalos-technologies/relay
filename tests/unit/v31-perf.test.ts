// V3.1 PERF unit tests: workload class gate, policies, per-provider caps, runner backpressure + pool scoping, bench stats.
import { describe, expect, it } from 'vitest';
import pg from 'pg';
import { getPool, runWithPool, setPool } from '@social-lite/db';
import { ClassGate, WorkloadRunner, withProviderClock, instrumentEngineDeps, type PressureSource } from '@social-lite/services/workload/runner';
import { workloadPolicies, QUEUE_CLASS } from '@social-lite/services/workload/policy';
import { providerConcurrency } from '@social-lite/services/engine/fairness';
import { WORKLOAD_CLASSES } from '@social-lite/core/contracts/v31-perf';
import type { EngineDeps } from '@social-lite/services';
import { summarize } from '../../scripts/bench/stats.js';

const tick = () => new Promise((r) => setTimeout(r, 5));

describe('ClassGate', () => {
  it('caps concurrency per class and per workspace, and wakes the first waiter that can run (no head-of-line blocking)', async () => {
    const g = new ClassGate(2, 1);
    expect(await g.acquire('A', 1000)).toBe(false);
    let bRan = false; let a2Ran = false;
    const a2 = g.acquire('A', 1000).then(() => { a2Ran = true; });
    const b = g.acquire('B', 1000).then(() => { bRan = true; });
    await tick();
    expect(bRan).toBe(true); // B is not blocked behind A's queued second item
    expect(a2Ran).toBe(false);
    expect(g.running).toBe(2);
    g.release('A');
    await a2;
    expect(a2Ran).toBe(true);
    g.release('A'); g.release('B');
    await b;
    expect(g.running).toBe(0);
  });

  it('a waiter that exceeds the slot wait runs anyway and is reported as overflow (never held past job expiry)', async () => {
    const g = new ClassGate(1, 1);
    await g.acquire(null, 1000);
    expect(await g.acquire(null, 20)).toBe(true);
    expect(g.running).toBe(2);
    expect(g.waiting).toBe(0);
  });
});

describe('workload policies', () => {
  it('defines every class; publishing and essential classes stay on the main pool and never defer', () => {
    const p = workloadPolicies({});
    expect(Object.keys(p).sort()).toEqual([...WORKLOAD_CLASSES].sort());
    for (const c of ['publishing', 'notifications', 'connection_health'] as const) {
      expect(p[c].pool).toBe('main');
      expect(p[c].defers_under_publishing_pressure).toBe(false);
    }
    for (const c of ['analytics_refresh', 'historical_backfill', 'video', 'report_export'] as const) {
      expect(p[c].pool).toBe('bulk');
      expect(p[c].defers_under_publishing_pressure).toBe(true);
    }
    expect(QUEUE_CLASS['media-transcode']).toBe('video');
    expect(QUEUE_CLASS['delivery-due']).toBe('publishing');
  });

  it('env overrides are bounded and per-workspace never exceeds the class cap', () => {
    const p = workloadPolicies({ WORKLOAD_VIDEO_CONCURRENCY: '3', WORKLOAD_VIDEO_PER_WORKSPACE: '9', WORKLOAD_REPORT_EXPORT_CONCURRENCY: '-1', WORKER_CONCURRENCY: '6' });
    expect(p.video).toMatchObject({ max_concurrent: 3, per_workspace: 3 });
    expect(p.report_export.max_concurrent).toBe(2); // invalid value ignored
    expect(p.publishing.max_concurrent).toBe(6);
  });

  it('per-provider dispatch caps: default 8, per-provider overrides, invalid values ignored', () => {
    expect(providerConcurrency({})).toEqual({ fallback: 8, caps: {} });
    expect(providerConcurrency({ DISPATCH_PROVIDER_CONCURRENCY: '3', DISPATCH_PROVIDER_CONCURRENCY_X: '1', DISPATCH_PROVIDER_CONCURRENCY_TIKTOK: 'zero' }))
      .toEqual({ fallback: 3, caps: { x: 1 } });
  });
});

describe('WorkloadRunner', () => {
  it('bulk classes defer while publishing is under pressure (bounded), essential classes do not', async () => {
    let active = true;
    const pressure: PressureSource = { check: async () => ({ active, reason: active ? 'test' : null }) };
    const r = new WorkloadRunner({ workerId: 't', pressure, policies: workloadPolicies({}), maxDeferMs: 2000, deferPollMs: 5 });
    const order: string[] = [];
    const bulk = r.run('historical_backfill', {}, async () => { order.push('bulk'); });
    await r.run('notifications', {}, async () => { order.push('notifications'); });
    await tick();
    expect(order).toEqual(['notifications']);
    active = false;
    await bulk;
    expect(order).toEqual(['notifications', 'bulk']);
  });

  it('never starves bulk: after maxDeferMs it runs even if pressure persists', async () => {
    const r = new WorkloadRunner({ workerId: 't', pressure: { check: async () => ({ active: true, reason: 'x' }) }, policies: workloadPolicies({}), maxDeferMs: 30, deferPollMs: 5 });
    const t = Date.now();
    await r.run('video', {}, async () => undefined);
    expect(Date.now() - t).toBeGreaterThanOrEqual(25);
  });

  it('bulk classes see the bulk pool through getPool(); publishing and main-pool classes see the main pool', async () => {
    const main = new pg.Pool({ max: 1 });
    const bulkPool = new pg.Pool({ max: 1 });
    setPool(main);
    try {
      const r = new WorkloadRunner({ workerId: 't', bulkPool, policies: workloadPolicies({}) });
      expect(await r.run('report_export', {}, async () => getPool())).toBe(bulkPool);
      expect(await r.run('notifications', {}, async () => getPool())).toBe(main);
      expect(await r.publishing({}, async () => getPool())).toBe(main);
      expect(getPool()).toBe(main);
      expect(runWithPool(bulkPool, () => getPool())).toBe(bulkPool);
    } finally {
      setPool(undefined);
      await main.end(); await bulkPool.end();
    }
  });

  it('errors propagate unchanged and release the slot', async () => {
    const r = new WorkloadRunner({ workerId: 't', policies: workloadPolicies({}) });
    await expect(r.run('video', {}, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(r.snapshot().video).toEqual({ running: 0, waiting: 0, deferring: 0 });
  });

  it('provider time is attributed to the item that spent it (instrumented adapters only)', async () => {
    const adapter = { publish: async () => { await new Promise((r) => setTimeout(r, 30)); return 'ok'; }, name: 'fake' };
    const deps = instrumentEngineDeps({ adapterFor: () => adapter } as unknown as EngineDeps);
    const { value, providerMs } = await withProviderClock(async () => {
      await new Promise((r) => setTimeout(r, 10));
      return (deps.adapterFor('x') as unknown as typeof adapter).publish();
    });
    expect(value).toBe('ok');
    expect(providerMs).toBeGreaterThanOrEqual(25);
    expect(providerMs).toBeLessThan(200);
    expect((deps.adapterFor('x') as unknown as typeof adapter).name).toBe('fake');
  });
});

describe('bench statistics', () => {
  it('nearest-rank percentiles with sample count and variability', () => {
    const s = summarize([5, 1, 4, 2, 3, 6, 7, 8, 9, 10]);
    expect(s).toMatchObject({ n: 10, p50: 5, p95: 10, min: 1, max: 10, mean: 5.5 });
    expect(s.cv).toBeGreaterThan(0);
    expect(summarize([]).n).toBe(0);
  });
});

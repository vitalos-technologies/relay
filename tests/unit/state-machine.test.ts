import { describe, expect, it } from 'vitest';
import { aggregateStatus, canTransition, isCancellable, decideRetry, canSchedule, can } from '@social-lite/core';

describe('delivery state machine', () => {
  it('allows the happy path and forbids regressions', () => {
    expect(canTransition('scheduled', 'preparing')).toBe(true);
    expect(canTransition('preparing', 'publishing')).toBe(true);
    expect(canTransition('publishing', 'published')).toBe(true);
    expect(canTransition('published', 'scheduled')).toBe(false);
    expect(canTransition('published', 'failed')).toBe(false);
    expect(canTransition('cancelled', 'scheduled')).toBe(false);
  });
  it('Unknown is never silently retried except via explicit manual path', () => {
    expect(canTransition('publishing', 'unknown')).toBe(true);
    expect(canTransition('unknown', 'retry_wait')).toBe(false);
    expect(canTransition('unknown', 'preparing')).toBe(false);
  });
  it('cancellation only before sending', () => {
    expect(isCancellable('scheduled', 'idle')).toBe(true);
    expect(isCancellable('preparing', 'preparing')).toBe(true);
    expect(isCancellable('preparing', 'sending')).toBe(false);
    expect(isCancellable('publishing', 'sending')).toBe(false);
  });
  it('aggregates partial success honestly', () => {
    expect(aggregateStatus(['published', 'published', 'published', 'failed'])).toBe('partial');
    expect(aggregateStatus(['published', 'published', 'published', 'unknown'])).toBe('needs_attention');
    expect(aggregateStatus(['published', 'published'])).toBe('published');
    expect(aggregateStatus(['scheduled', 'scheduled'])).toBe('scheduled');
    expect(aggregateStatus(['failed', 'failed'])).toBe('failed');
    expect(aggregateStatus(['published', 'scheduled'])).toBe('publishing');
  });
});

describe('retry policy', () => {
  const now = new Date('2026-11-10T09:00:00Z');
  const far = new Date('2026-11-10T12:00:00Z');
  it('backs off ~30s, 2m, 5m, 10m and stops at 5 attempts', () => {
    const mid = () => 0.5;
    const delays = [1, 2, 3, 4].map((n) => decideRetry({ attemptNumber: n, maxAttempts: 5, now, publishBefore: far, rand: mid }).at!.getTime() - now.getTime());
    expect(delays).toEqual([30_000, 120_000, 300_000, 600_000]);
    expect(decideRetry({ attemptNumber: 5, maxAttempts: 5, now, publishBefore: far }).retry).toBe(false);
  });
  it('honours Retry-After and the publish-before deadline', () => {
    const r = decideRetry({ attemptNumber: 1, maxAttempts: 5, now, publishBefore: far, providerRetryAfterMs: 90_000, rand: () => 0.5 });
    expect(r.at!.getTime() - now.getTime()).toBe(90_000);
    const d = decideRetry({ attemptNumber: 1, maxAttempts: 5, now, publishBefore: new Date(now.getTime() + 10_000) });
    expect(d).toEqual({ retry: false, reason: 'deadline' });
  });
});

describe('permissions', () => {
  it('follows the role matrix', () => {
    expect(can('viewer', 'drafts.edit')).toBe(false);
    expect(can('approver', 'pause.emergency')).toBe(true);
    expect(can('editor', 'pause.emergency')).toBe(false);
    expect(can('admin', 'workspace.manage_ownership')).toBe(false);
    expect(canSchedule({ role: 'editor', editorsCanPublish: false, approvalRequired: false, contentApproved: false }).allowed).toBe(false);
    expect(canSchedule({ role: 'approver', editorsCanPublish: false, approvalRequired: true, contentApproved: true }).allowed).toBe(true);
    expect(canSchedule({ role: 'viewer', editorsCanPublish: true, approvalRequired: false, contentApproved: true }).allowed).toBe(false);
  });
});

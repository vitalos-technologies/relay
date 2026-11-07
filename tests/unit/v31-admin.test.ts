// V3.1 Admin pure rules: platform role/assurance checks, redaction of job errors, dead-letter requeue allow-list, sync targets.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ADMIN_SYNC, ADMIN_TOPICS, HEALTH_STATES } from '@social-lite/core/contracts/v31-admin';
import { isFresh, requireFresh, requirePlatform, type PlatformCtx } from '../../packages/services/src/admin/platform.js';
import { safeError } from '../../packages/services/src/admin/reads.js';
import { REQUEUE_SAFE } from '../../packages/services/src/admin/publishing.js';

const p = (role: 'operator' | 'support', authAgoS: number | null, mfa = true): PlatformCtx => ({
  actor: { userId: randomUUID(), email: 'op@relay.test', name: null, sessionId: randomUUID() }, role, correlationId: 'c',
  assurance: { mfaVerified: mfa, authTime: authAgoS === null ? null : new Date(Date.now() - authAgoS * 1000) },
});

describe('platform authority', () => {
  it('support ⊂ operator', () => {
    expect(() => requirePlatform(p('support', 0), 'support')).not.toThrow();
    expect(() => requirePlatform(p('support', 0), 'operator')).toThrow(expect.objectContaining({ code: 'forbidden' }));
    expect(() => requirePlatform(p('operator', 0), 'operator')).not.toThrow();
  });
  it('platform changes need MFA within the step-up window', () => {
    expect(isFresh(p('operator', 10))).toBe(true);
    expect(isFresh(p('operator', 10, false))).toBe(false);
    expect(isFresh(p('operator', 3600))).toBe(false);
    expect(isFresh(p('operator', null))).toBe(false);
    expect(() => requireFresh(p('operator', 3600))).toThrow(expect.objectContaining({ code: 'step_up_required' }));
  });
});

describe('admin safety rules', () => {
  it('job errors never carry tokens', () => {
    const s = safeError('GET https://graph.facebook.com/v26.0/me?access_token=EAABsecret123&fields=id → 400 Authorization: Bearer abc.def.ghi1234567 ghp_abcdefghijklmnopqrstu')!;
    expect(s).not.toMatch(/EAABsecret123|abc\.def\.ghi1234567|ghp_abcdefghijklmnopqrstu/);
    expect(s.length).toBeLessThanOrEqual(200);
    expect(safeError(null)).toBeNull();
  });
  it('only idempotent, state-reloading event types can be requeued (never emails or external writes)', () => {
    expect(REQUEUE_SAFE.has('delivery.due')).toBe(true);
    for (const t of ['invitation.created', 'notification.created', 'writeback.requested', 'delivery.state_changed']) expect(REQUEUE_SAFE.has(t)).toBe(false);
  });
  it('sync targets and vocabularies are stable', () => {
    expect(ADMIN_SYNC.poll_ms).toBe(10_000);
    expect(ADMIN_SYNC.max_backoff_ms).toBeLessThanOrEqual(60_000);
    expect(ADMIN_TOPICS).toContain('access');
    expect(HEALTH_STATES).toEqual(['healthy', 'degraded', 'failed', 'paused', 'unknown', 'awaiting_setup', 'unsupported', 'demo']);
  });
});

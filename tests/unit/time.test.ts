import { describe, expect, it } from 'vitest';
import { resolveWallTime, resolveWallTimeWithOffset, toLocalInput, offsetMinutes } from '@social-lite/core';

describe('DST handling (Europe/London)', () => {
  it('resolves an ordinary winter time to UTC', () => {
    const r = resolveWallTime('2026-11-10T09:00', 'Europe/London');
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.instant.toISOString()).toBe('2026-11-10T09:00:00.000Z');
  });
  it('resolves summer time with +01:00', () => {
    const r = resolveWallTime('2026-07-01T09:00', 'Europe/London');
    expect(r.kind === 'ok' && r.instant.toISOString()).toBe('2026-07-01T08:00:00.000Z');
  });
  it('rejects a nonexistent spring-forward time (gap)', () => {
    // 2026-03-29 01:00 -> 02:00 in London
    expect(resolveWallTime('2026-03-29T01:30', 'Europe/London').kind).toBe('gap');
  });
  it('requires an offset choice for an ambiguous fall-back time (fold)', () => {
    // 2026-10-25 02:00 BST -> 01:00 GMT
    const r = resolveWallTime('2026-10-25T01:30', 'Europe/London');
    expect(r.kind).toBe('ambiguous');
    if (r.kind === 'ambiguous') {
      expect(r.options.map((o) => o.offset)).toEqual(['+01:00', '+00:00']);
      expect(r.options.map((o) => o.instant.toISOString())).toEqual(['2026-10-25T00:30:00.000Z', '2026-10-25T01:30:00.000Z']);
    }
    const chosen = resolveWallTimeWithOffset('2026-10-25T01:30', 'Europe/London', '+00:00');
    expect(chosen.kind === 'ok' && chosen.instant.toISOString()).toBe('2026-10-25T01:30:00.000Z');
  });
  it('rejects impossible calendar dates and unknown zones', () => {
    expect(resolveWallTime('2026-02-30T10:00', 'Europe/London').kind).toBe('invalid');
    expect(resolveWallTime('2026-02-10T10:00', 'Mars/Olympus').kind).toBe('invalid');
  });
  it('round-trips and handles other zones', () => {
    const r = resolveWallTime('2026-03-08T02:30', 'America/New_York');
    expect(r.kind).toBe('gap');
    expect(toLocalInput(new Date('2026-11-10T09:00:00Z'), 'Asia/Kolkata')).toBe('2026-11-10T14:30');
    expect(offsetMinutes(new Date('2026-07-01T00:00:00Z'), 'Europe/London')).toBe(60);
  });
});

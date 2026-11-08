// V4 Relay support (SUP) — pure helpers: redaction, diagnostics allow-list, browser family, file signatures, AI guards,
// customer activity wording (never staff names), contract invariants.
import { describe, expect, it } from 'vitest';
import {
  RESTRICTED_SUPPORT_CATEGORIES, SUPPORT_ATTACHMENT_TYPES, SUPPORT_CATEGORY_LABEL, SUPPORT_QUEUES, SUPPORT_TICKET_CATEGORIES, SUPPORT_SOURCES, SUPPORT_REQUESTER_KINDS,
} from '../../packages/core/src/contracts/v4-support.js';
import { activityText, browserFamily, redactSecrets, safeDiagnostics, staffPublicName } from '../../packages/services/src/support/shared.js';
import { sniffMatches } from '../../packages/services/src/support/attachments.js';
import { suggestCategory, unsupportedClaims } from '../../packages/services/src/support/ai.js';
import { isSupportStaffRole } from '../../packages/services/src/support/access.js';

describe('support contract', () => {
  it('keeps V5 visitor/widget open, a restricted category, labels for every category and the brief queues', () => {
    expect(SUPPORT_REQUESTER_KINDS).toEqual(['member', 'visitor']);
    expect(SUPPORT_SOURCES).toContain('widget');
    expect(RESTRICTED_SUPPORT_CATEGORIES).toEqual(['security']);
    for (const c of SUPPORT_TICKET_CATEGORIES) expect(SUPPORT_CATEGORY_LABEL[c]).toBeTruthy();
    expect(SUPPORT_QUEUES).toEqual(expect.arrayContaining(['unassigned', 'mine', 'waiting_on_relay', 'waiting_on_customer', 'resolved', 'archived']));
    expect(SUPPORT_ATTACHMENT_TYPES).not.toContain('image/svg+xml'); // scriptable formats are not allowed
  });
  it('support staff roles: operator and support only (billing staff never)', () => {
    expect(isSupportStaffRole('support')).toBe(true);
    expect(isSupportStaffRole('operator')).toBe(true);
    expect(isSupportStaffRole('billing')).toBe(false);
    expect(isSupportStaffRole(null)).toBe(false);
  });
});

describe('redaction and diagnostics', () => {
  it('redacts credentials but keeps e-mail addresses', () => {
    const r = redactSecrets('login jo@acme.test password: hunter2 Bearer abcdefghijklmnop key ghp_abcdefghijklmnopqrstuvwxyz card 4111 1111 1111 1111');
    expect(r.text).toContain('jo@acme.test');
    expect(r.text).toContain('password=<redacted>');
    expect(r.text).not.toMatch(/hunter2|abcdefghijklmnop|ghp_|4111/);
    expect(r.count).toBeGreaterThanOrEqual(4);
  });
  it('diagnostics: path only, allow-listed keys, safe ids', () => {
    expect(safeDiagnostics({ route: '/x/y?code=1', app_version: '4.0.0', browser_family: 'firefox', correlation_ids: ['ok_12345678', 'bad id!'], error_code: 'auth.expired',
      ...({ cookies: 'a', localStorage: 'b' } as object) } as never)).toEqual({ route: '/x/y', app_version: '4.0.0', browser_family: 'firefox', correlation_ids: ['ok_12345678'], error_code: 'auth.expired' });
    expect(safeDiagnostics({ browser_family: 'netscape', app_version: '<script>' } as never)).toEqual({});
  });
  it('browser family only', () => {
    expect(browserFamily('Mozilla/5.0 (X11; Linux) Gecko/20100101 Firefox/131.0')).toBe('firefox');
    expect(browserFamily('Mozilla/5.0 Chrome/129.0 Mobile Safari/537.36 SamsungBrowser/26.0')).toBe('samsung');
    expect(browserFamily('Mozilla/5.0 (iPhone) CriOS/129.0 Mobile Safari/604.1')).toBe('chrome');
    expect(browserFamily(null)).toBeNull();
  });
});

describe('attachment signatures', () => {
  it('accepts matching magic bytes only', () => {
    expect(sniffMatches('image/png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe(true);
    expect(sniffMatches('image/png', Buffer.from('GIF89a'))).toBe(false);
    expect(sniffMatches('image/jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe(true);
    expect(sniffMatches('image/gif', Buffer.from('GIF89a....'))).toBe(true);
    expect(sniffMatches('image/webp', Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe(true);
    expect(sniffMatches('application/pdf', Buffer.from('<html>'))).toBe(false);
    expect(sniffMatches('text/plain', Buffer.from([0xc3, 0x28]))).toBe(false); // invalid UTF-8
    expect(sniffMatches('application/zip', Buffer.from('PK'))).toBe(false);
  });
});

describe('AI guards and wording', () => {
  it('suggests categories from keywords and flags unsupported claims', () => {
    expect(suggestCategory('Someone hacked my account')).toBe('security');
    expect(suggestCategory('Instagram keeps disconnecting')).toBe('connections');
    expect(suggestCategory('It would be great if you could add dark mode')).toBe('feature_request');
    expect(unsupportedClaims('Your subscription has been cancelled.')).toBeTruthy();
    expect(unsupportedClaims('A refund was issued today')).toBeTruthy();
    expect(unsupportedClaims('I will ask a colleague to check.')).toBeNull();
  });
  it('customer activity never names staff; staff lines do', () => {
    expect(activityText('status.resolved', { reason: 'fixed', actor_name: 'Sam Support' }, false)).toBe('Resolved · fixed');
    expect(activityText('status.resolved', { reason: 'fixed', actor_name: 'Sam Support' }, true)).toBe('Resolved · fixed by Sam Support');
    expect(activityText('access.requested', { actor_name: 'Sam Support' }, false)).not.toContain('Sam');
    expect(staffPublicName('Sam Support')).toBe('Sam · Relay');
    expect(staffPublicName(null)).toBe('Relay support');
  });
});

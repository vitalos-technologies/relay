import { describe, expect, it } from 'vitest';
import type { AdapterContext, HttpRequest } from '@social-lite/core';
import { revokeXToken } from '@social-lite/providers/x/index';

function ctxWith(status: number, sent: HttpRequest[]): AdapterContext {
  return {
    transport: { mode: 'live', send: async (r) => { sent.push(r); return { status, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ revoked: true }) }; } },
    now: () => new Date('2026-11-06T12:00:00Z'), config: { clientId: 'cid', clientSecret: 'csecret' },
  };
}

describe('X token revocation', () => {
  it('posts the refresh token to /2/oauth2/revoke with client authentication', async () => {
    const sent: HttpRequest[] = [];
    const ok = await revokeXToken(ctxWith(200, sent), { kind: 'oauth2', accessToken: 'at-1', refreshToken: 'rt-1' });
    expect(ok).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.method).toBe('POST');
    expect(new URL(sent[0]!.url).pathname).toBe('/2/oauth2/revoke');
    const body = new URLSearchParams(String(sent[0]!.body));
    expect(body.get('token')).toBe('rt-1');
    expect(body.get('token_type_hint')).toBe('refresh_token');
    expect(sent[0]!.headers?.authorization ?? sent[0]!.headers?.Authorization).toMatch(/^Basic /);
    expect(sent[0]!.url).not.toContain('rt-1');
  });
  it('is best effort: provider errors return false, never throw', async () => {
    expect(await revokeXToken(ctxWith(503, []), { kind: 'oauth2', accessToken: 'a' })).toBe(false);
    expect(await revokeXToken(ctxWith(200, []), { kind: 'telegram_bot', botToken: 'x' })).toBe(false);
  });
});

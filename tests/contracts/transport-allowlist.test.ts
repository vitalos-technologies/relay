// Live transport allow-list: only provider hosts; operators may add exact hostnames (self-hosted Bluesky servers).
import { describe, expect, it } from 'vitest';
import { TransportError } from '@social-lite/core';
import { HttpTransport, isProviderHostAllowed, parseExtraHosts } from '@social-lite/providers';

describe('provider host allow-list', () => {
  it('parses operator hostnames strictly', () => {
    expect(parseExtraHosts(' PDS.Example.org, pds.example.org ,bad host, http://x.org, 10.0.0.1, localhost, *.evil.com, a.b:443 ')).toEqual(['pds.example.org']);
    expect(parseExtraHosts(undefined)).toEqual([]);
  });
  it('allows provider hosts and Bluesky-hosted PDS suffixes, nothing else', () => {
    expect(isProviderHostAllowed('bsky.social')).toBe(true);
    expect(isProviderHostAllowed('morel.us-east.host.bsky.network')).toBe(true);
    expect(isProviderHostAllowed('host.bsky.network.evil.com')).toBe(false);
    expect(isProviderHostAllowed('pds.example.org')).toBe(false);
    expect(isProviderHostAllowed('pds.example.org', ['pds.example.org'])).toBe(true);
  });
  it('refuses non-allow-listed hosts before any network call; extra hosts are honoured', async () => {
    const t = new HttpTransport();
    await expect(t.send({ method: 'GET', url: 'https://pds.example.org/xrpc/x', op: 't' })).rejects.toBeInstanceOf(TransportError);
    await expect(t.send({ method: 'GET', url: 'http://bsky.social/xrpc/x', op: 't' })).rejects.toThrow(/host not allowed/);
    const withExtra = new HttpTransport({ extraHosts: ['pds.example.org'], defaultTimeoutMs: 1 });
    // allowed past the gate: fails on the (blocked/absent) network instead of the allow-list
    await expect(withExtra.send({ method: 'GET', url: 'https://pds.example.org/xrpc/x', op: 't' })).rejects.not.toThrow(/host not allowed/);
  });
});

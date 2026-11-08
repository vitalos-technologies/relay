// monday.com connector (hub adapter). OAuth (no PKCE); tokens do not expire. Board webhooks are created per installation
// (URL carries ?i=<installation>) and verified with the app signing secret (JWT).
import { MONDAY_HOSTS, MONDAY_SCOPES, lastComplexity, mondayAuthorizeUrl, mondayBoards, mondayExchange, mondayMe, mondayUsers } from '@social-lite/providers/monday/client';
import { mondaySim } from '@social-lite/providers/monday/sim';
import type { HubAdapter } from '../core/types.js';
import { saveRateLimit } from '../core/runtime.js';

export const mondayAdapter: HubAdapter = {
  connector: 'monday', hosts: MONDAY_HOSTS, sim: mondaySim, connect: 'oauth', webhook: 'per_installation',
  required: ['MONDAY_CLIENT_ID', 'MONDAY_CLIENT_SECRET'], optional: ['MONDAY_SIGNING_SECRET', 'MONDAY_API_VERSION'],
  capabilities: ['Create an item from a post, campaign, conversation or case', 'Link an existing item', 'Map status, date and priority columns', 'Two-way name, date and status (when mapped)'],
  authorizeUrl: (cfg, p) => mondayAuthorizeUrl({ clientId: cfg.values.MONDAY_CLIENT_ID!, redirectUri: cfg.redirectUri, state: p.state }),
  async exchange(t, cfg, p) {
    const tok = await mondayExchange(t, { clientId: cfg.values.MONDAY_CLIENT_ID!, clientSecret: cfg.values.MONDAY_CLIENT_SECRET!, redirectUri: cfg.redirectUri, code: p.code });
    const me = await mondayMe({ t, token: tok.accessToken, apiVersion: cfg.values.MONDAY_API_VERSION });
    return { externalAccountId: me.account.id, displayName: `monday.com · ${me.account.name}`, grantedScopes: tok.scopes ?? [...MONDAY_SCOPES],
      creds: { accessToken: tok.accessToken, refreshToken: null, expiresAt: null }, settings: { account_slug: me.account.slug, api_version: cfg.values.MONDAY_API_VERSION ?? null },
      health: { status: 'active', message: `Connected as ${me.name}.` } };
  },
  async verify(c) {
    const me = await mondayMe(c);
    if (lastComplexity) await saveRateLimit(c.integrationId, { remaining: lastComplexity.after, limit: null, reset_at: new Date(Date.now() + lastComplexity.reset_in_x_seconds * 1000).toISOString(), source: 'complexity budget' });
    return { status: 'active', message: `Connected as ${me.name}.` };
  },
  async discover(c, p) {
    if (p.type === 'user') return (await mondayUsers(c)).map((u) => ({ resource_type: 'user', external_id: u.id, name: u.name, url: null, selected: false }));
    const boards = await mondayBoards(c);
    if (p.type === 'column') {
      const b = boards.find((x) => x.id === p.parent);
      return (b?.columns ?? []).filter((x) => ['status', 'date', 'text'].includes(x.type)).map((x) => ({ resource_type: 'column', external_id: x.id, name: x.title, url: null, detail: x.type, selected: false }));
    }
    return boards.map((b) => ({ resource_type: 'board', external_id: b.id, name: b.name, url: b.url, detail: `${b.groups.length} group${b.groups.length === 1 ? '' : 's'}`, selected: false }));
  },
};

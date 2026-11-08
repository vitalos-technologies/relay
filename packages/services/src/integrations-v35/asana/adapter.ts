// Asana connector (hub adapter). OAuth with PKCE; Asana grants exactly the requested scopes or refuses the sign-in
// (forbidden_scopes), so a completed sign-in means the requested scopes were granted.
import { ASANA_HOSTS, ASANA_SCOPES, asanaAuthorizeUrl, asanaCreateWebhook, asanaExchange, asanaMe, asanaProjects, asanaUsers, asanaWorkspaces } from '@social-lite/providers/asana/client';
import { asanaSim } from '@social-lite/providers/asana/sim';
import type { HubAdapter } from '../core/types.js';

export const asanaAdapter: HubAdapter = {
  connector: 'asana', hosts: ASANA_HOSTS, sim: asanaSim, connect: 'oauth', pkce: true, webhook: 'per_installation',
  required: ['ASANA_CLIENT_ID', 'ASANA_CLIENT_SECRET'],
  capabilities: ['Create a task from a post, campaign, conversation or case', 'Link an existing task', 'Show task status in Relay', 'Two-way title, due date and completion (when mapped)'],
  authorizeUrl: (cfg, p) => asanaAuthorizeUrl({ clientId: cfg.values.ASANA_CLIENT_ID!, redirectUri: cfg.redirectUri, state: p.state, codeChallenge: p.codeChallenge }),
  async exchange(t, cfg, p) {
    const tok = await asanaExchange(t, { clientId: cfg.values.ASANA_CLIENT_ID!, clientSecret: cfg.values.ASANA_CLIENT_SECRET!, redirectUri: cfg.redirectUri, code: p.code, codeVerifier: p.codeVerifier });
    const me = await asanaMe({ t, token: tok.accessToken });
    return { externalAccountId: me.gid, displayName: `Asana · ${me.name}`, grantedScopes: [...ASANA_SCOPES], creds: tok,
      health: { status: 'active', message: `Connected as ${me.name} (${me.workspaces.length} workspace${me.workspaces.length === 1 ? '' : 's'}).` } };
  },
  async refresh(t, cfg, creds) {
    if (!creds.refreshToken) return null;
    const tok = await asanaExchange(t, { clientId: cfg.values.ASANA_CLIENT_ID!, clientSecret: cfg.values.ASANA_CLIENT_SECRET!, redirectUri: cfg.redirectUri, refreshToken: creds.refreshToken });
    return { accessToken: tok.accessToken, refreshToken: tok.refreshToken, expiresAt: tok.expiresAt };
  },
  async verify(c) { const me = await asanaMe(c); return { status: 'active', message: `Connected as ${me.name}.` }; },
  async discover(c, p) {
    if (p.type === 'workspace') return (await asanaWorkspaces(c)).map((w) => ({ resource_type: 'workspace', external_id: w.gid, name: w.name, url: null, selected: false }));
    if (p.type === 'user') {
      const ws = p.parent ?? (await asanaWorkspaces(c))[0]?.gid;
      return ws ? (await asanaUsers(c, ws)).map((u) => ({ resource_type: 'user', external_id: u.gid, name: u.name, url: null, selected: false })) : [];
    }
    const workspaces = p.parent ? [{ gid: p.parent, name: '' }] : (await asanaWorkspaces(c)).slice(0, 5);
    const out = [];
    for (const w of workspaces) for (const pr of await asanaProjects(c, w.gid)) out.push({ resource_type: 'project', external_id: pr.gid, name: pr.name, url: pr.permalink_url ?? null, detail: w.name || null, selected: false });
    return out;
  },
};

export { asanaCreateWebhook };

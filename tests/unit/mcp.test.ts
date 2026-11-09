// MCP pure logic: scope parsing/mapping, scope challenges, automation-policy coverage, and the tool catalogue.
import { beforeAll, describe, expect, it } from 'vitest';
import { PERMISSIONS } from '@social-lite/core';
import type { PostRow } from '@social-lite/services';
import { MCP_CUSTOMER_DATA_SCOPES, MCP_DEFAULT_SCOPES, MCP_SCOPES, MCP_SCOPE_PERMISSIONS, MCP_TOOLS } from '@social-lite/core/contracts/mcp';
import { resetConfigCache } from '@social-lite/services';

beforeAll(() => {
  process.env.DATABASE_URL ??= 'postgres://unit-test';
  process.env.APP_BASE_URL = 'https://relay.example.com';
  resetConfigCache();
});

describe('MCP scopes', () => {
  it('parses only known scopes, deduplicated and ordered', async () => {
    const { parseScopes } = await import('@social-lite/services/mcp/auth');
    expect(parseScopes('openid drafts.write social.read drafts.write admin offline_access')).toEqual(['social.read', 'drafts.write']);
    expect(parseScopes(['reports.export', 42, 'social.read'])).toEqual(['social.read', 'reports.export']);
    expect(parseScopes(undefined)).toEqual([]);
  });

  it('maps scopes to V2 permissions that never include administration', () => {
    const all = new Set(MCP_SCOPES.flatMap((s) => [...MCP_SCOPE_PERMISSIONS[s]]));
    for (const p of all) expect(PERMISSIONS).toContain(p);
    for (const forbidden of ['members.manage', 'members.invite', 'security.manage', 'service_accounts.manage', 'workspace.manage', 'workspace.transfer_owner', 'connections.manage', 'content.approve', 'teams.manage', 'publishing.resume'] as const) {
      expect(all.has(forbidden)).toBe(false);
    }
    expect(MCP_SCOPE_PERMISSIONS['social.read'].some((p) => !p.endsWith('.read'))).toBe(false);
  });

  it('catalogue: every tool has scopes; read-only tools are never destructive', () => {
    expect(new Set(MCP_TOOLS.map((t) => t.name)).size).toBe(MCP_TOOLS.length);
    // 27 V3 tools + 4 V3.1 DATA (search, recovery, bulk preview/status) + 2 V3.1 GOV (get_brand_rules, get_integration_diagnostics)
    // + 14 V3.5 (inbox reads, draft_reply, assignment, cases, listening, AI preparation).
    expect(MCP_TOOLS).toHaveLength(47);
    for (const t of MCP_TOOLS) {
      expect(t.scopes.length).toBeGreaterThan(0);
      if (t.readOnly) expect(t.destructive).toBe(false);
      expect(t.name).toMatch(/^[a-z_]{3,64}$/);
    }
  });

  it('V3.5: no send, notification or mass-mention tool; customer-data scopes are opt-in; AI preparation adds only ai.use', () => {
    const names = MCP_TOOLS.map((t) => t.name);
    for (const n of names) expect(n).not.toMatch(/send|notify|mention|broadcast|publish_reply|apply_action/);
    expect(names).toEqual(expect.arrayContaining(['list_conversations', 'get_conversation', 'draft_reply', 'assign_conversation', 'list_cases', 'get_case', 'create_case', 'update_case',
      'list_listening_searches', 'query_listening', 'list_listening_alerts', 'get_listening_alert', 'prepare_with_ai', 'get_ai_result']));
    for (const s of MCP_CUSTOMER_DATA_SCOPES) expect(MCP_DEFAULT_SCOPES).not.toContain(s);
    expect([...MCP_SCOPE_PERMISSIONS['ai.prepare']]).toEqual(['ai.use']);
    // Drafting a reply grants inbox.reply but no tool can send: the only inbox.draft tool is draft_reply.
    expect(MCP_TOOLS.filter((t) => t.scopes.includes('inbox.draft') && t.name !== 'list_workspaces').map((t) => t.name)).toEqual(['draft_reply']);
    // Reads stay read-only; every V3.5 mutation is idempotent (idempotency_key) and never destructive.
    for (const t of MCP_TOOLS.filter((x) => ['inbox', 'cases', 'listening', 'assist'].includes(x.group))) {
      expect(t.idempotent).toBe(true);
      expect(t.destructive).toBe(false);
    }
    for (const s of ['inbox.read', 'listening.read'] as const) expect(MCP_SCOPE_PERMISSIONS[s].every((p) => p.endsWith('.read'))).toBe(true);
  });

  it('builds RFC 6750 challenges with resource metadata, ASCII-only descriptions', async () => {
    const { challenge, requiredScopes } = await import('@social-lite/services/mcp/server');
    expect(challenge()).toBe('Bearer resource_metadata="https://relay.example.com/.well-known/oauth-protected-resource/mcp", scope="social.read drafts.write"');
    const c = challenge({ error: 'insufficient_scope', scope: ['social.read', 'reports.export'], description: 'Needs "reports" → export' });
    expect(c).toMatch(/^Bearer error="insufficient_scope", resource_metadata=".+", scope="social.read reports.export", error_description="Needs reports > export"$/);
    expect(requiredScopes([
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'create_draft', arguments: {} } },
      { jsonrpc: '2.0', id: 2, method: 'resources/read', params: { uri: 'relay://workspaces/x/reports/y' } },
      { jsonrpc: '2.0', id: 3, method: 'tools/list' },
    ])).toEqual([['drafts.write'], ['reports.export', 'social.read']]);
  });
});

describe('MCP automation policy coverage', () => {
  const now = new Date('2026-11-07T10:00:00Z');
  const grant = {
    id: 'g', client_row_id: 'c', actor_user_id: 'u', brand_id: 'b', connection_ids: ['conn-a'], allow_immediate: false,
    valid_from: new Date('2026-11-01T00:00:00Z'), valid_until: new Date('2026-11-20T00:00:00Z'), max_days_ahead: 7, local_start_hour: 8, local_end_hour: 20,
    max_per_day: 3, max_text_length: 100, allow_links: false, allow_media: false, revoked_at: null,
  };
  const post = (text: string, extra: Partial<PostRow['draft']> = {}) => ({ draft: { baseText: text, baseLink: null, baseAssetIds: [], variants: [], ...extra } }) as unknown as PostRow;
  const intent = (due: string | null, conns = ['conn-a'], mode: 'scheduled' | 'immediate' = 'scheduled') => ({ mode, connection_ids: conns, due_at: due ? new Date(due) : null, input_timezone: 'Europe/London' });

  it('covers an intent inside every limit and names the first gap otherwise', async () => {
    const { grantGap } = await import('@social-lite/services/mcp/intents');
    expect(grantGap(grant, intent('2026-11-08T09:00:00Z'), post('Hello'), now)).toBeNull();
    expect(grantGap({ ...grant, revoked_at: now }, intent('2026-11-08T09:00:00Z'), post('Hello'), now)).toBe('revoked');
    expect(grantGap(grant, intent('2026-11-08T09:00:00Z', ['conn-b']), post('Hello'), now)).toBe('destination not allowed');
    expect(grantGap(grant, intent(null, ['conn-a'], 'immediate'), post('Hello'), now)).toBe('immediate publishing not allowed');
    expect(grantGap(grant, intent('2026-11-16T09:00:00Z'), post('Hello'), now)).toBe('too far ahead');
    expect(grantGap(grant, intent('2026-11-08T21:30:00Z'), post('Hello'), now)).toBe('outside allowed hours');
    expect(grantGap(grant, intent('2026-11-08T09:00:00Z'), post('x'.repeat(101)), now)).toBe('text too long');
    expect(grantGap(grant, intent('2026-11-08T09:00:00Z'), post('see https://example.com'), now)).toBe('links not allowed');
    expect(grantGap(grant, intent('2026-11-08T09:00:00Z'), post('Hello', { baseAssetIds: ['a'] }), now)).toBe('media not allowed');
    expect(grantGap(grant, intent('2026-11-08T09:00:00Z'), post('Hello'), new Date('2026-11-21T00:00:00Z'))).toBe('outside validity window');
  });
});

describe('MCP error codes (M19)', () => {
  it('every code toToolError can return is in the published MCP_ERROR_CODES list', async () => {
    const { MCP_ERROR_CODES } = await import('@social-lite/core/contracts/mcp');
    const { AppError } = await import('@social-lite/core');
    const { toToolError } = await import('@social-lite/services/mcp/principal');
    const appCodes = ['unauthenticated', 'forbidden', 'not_found', 'validation_failed', 'conflict', 'version_conflict', 'idempotency_conflict',
      'rate_limited', 'csrf_failed', 'provider_not_configured', 'provider_error', 'invalid_state', 'payload_too_large', 'unsupported_media',
      'budget_exhausted', 'dispatch_disabled', 'mfa_required', 'step_up_required', 'entitlement_required', 'internal'] as const;
    for (const c of appCodes) expect(MCP_ERROR_CODES).toContain(toToolError(new AppError(c, 'x')).code);
    expect(toToolError(new AppError('entitlement_required', 'Upgrade', undefined, { feature: 'mcp' }))).toMatchObject({ code: 'entitlement_required', details: { feature: 'mcp' } });
    expect(MCP_ERROR_CODES).toContain(toToolError(new AppError('validation_failed', 'x', undefined, { reason: 'ambiguous_time' })).code);
    expect(MCP_ERROR_CODES).toContain(toToolError(new AppError('forbidden', 'x', undefined, { reason: 'approval_required' })).code);
  });
});

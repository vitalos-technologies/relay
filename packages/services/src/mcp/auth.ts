// MCP authentication (OAuth 2.x resource server, MCP authorization spec 2025-11-25).
//  - Bearer JWT access tokens from the configured authorization server (Keycloak realm): signature against the
//    issuer's published JWKS (asymmetric algorithms only), issuer, audience = the canonical MCP resource URI
//    (RFC 8707), exp/iat, token type, client id (azp) and scopes. Invalid/expired ⇒ 401 invalid_token.
//  - Relay service-account API keys (sl_live_…) as an alternative principal for scripted clients
//    (services/service-accounts.ts: revocation/expiry checked against the database on every request).
//  - No token passthrough: the raw token never leaves this module (AuthInfo carries a fingerprint only) and Relay
//    never hands Google/Notion/social credentials to MCP clients.
//  - Client registry: the first valid token from (user, client) creates a PENDING registration the user must consent
//    to in the Relay app (workspace, brands, scopes). A registration revoked in Relay rejects that client
//    (401 invalid_token) until the user allows it again.
import { createHash } from 'node:crypto';
import { MCP_SCOPES, isMcpScope, type McpScope } from '@social-lite/core/contracts/mcp';
import { getPool, many, maybeOne, type Queryable } from '@social-lite/db';
import { JwtError, jwksResolver, verifyJwt, type Jwk, type KeyResolver } from '../auth/jwt.js';
import { SECOND_FACTOR_AMR } from '../auth/session.js';
import { authenticateApiKey } from '../service-accounts.js';
import { log } from '../log.js';
import { mcpConfig } from './config.js';

export interface McpPrincipal {
  kind: 'user' | 'service_account';
  /** Stable fingerprint used to bind protocol sessions (sessions are never authorization identities). */
  key: string;
  userId: string | null;
  email: string;
  name: string | null;
  serviceAccountId: string | null;
  apiKeyId: string | null;
  /** Service accounts are bound to one workspace. */
  workspaceId: string | null;
  /** OAuth client id (azp) or the API key prefix. */
  clientId: string;
  clientKind: 'oauth' | 'api_key';
  issuer: string | null;
  tokenScopes: McpScope[];
  assurance: { mfaVerified: boolean; authTime: string | null };
  expiresAt: number | null;
  tokenFingerprint: string;
}

export type AuthOutcome =
  | { ok: true; principal: McpPrincipal }
  | { ok: false; status: 401 | 403 | 400; error: 'invalid_request' | 'invalid_token' | 'insufficient_scope'; description: string };

// ------------------------------------------------------------------ key resolution (JWKS via discovery)

interface Overrides { keys?: KeyResolver; issuer?: string }
let overrides: Overrides | null = null;

/** Tests only: inject a key resolver / issuer (never honoured outside APP_ENV=test). */
export function setMcpAuthTestOverrides(o: Overrides | null): void {
  if (process.env.APP_ENV !== 'test') throw new Error('MCP auth overrides are test-only');
  overrides = o;
}

let resolverCache: { issuer: string; resolve: KeyResolver } | undefined;

async function discoverJwksUri(issuer: string): Promise<string> {
  const res = await fetch(`${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(8000), redirect: 'error' });
  if (!res.ok) throw new Error(`discovery ${res.status}`);
  const meta = (await res.json()) as { issuer?: string; jwks_uri?: string };
  if (meta.issuer !== issuer || !meta.jwks_uri) throw new Error('discovery issuer mismatch');
  return meta.jwks_uri;
}

function keysFor(issuer: string): KeyResolver {
  if (overrides?.keys) return overrides.keys;
  if (!resolverCache || resolverCache.issuer !== issuer) {
    let uri: Promise<string> | null = null;
    resolverCache = {
      issuer,
      resolve: jwksResolver(async () => {
        uri ??= discoverJwksUri(issuer).catch((e) => { uri = null; throw e; });
        const res = await fetch(await uri, { signal: AbortSignal.timeout(8000), redirect: 'error' });
        if (!res.ok) throw new Error(`jwks ${res.status}`);
        return (await res.json()) as { keys: Jwk[] };
      }),
    };
  }
  return resolverCache.resolve;
}

export function expectedIssuer(): string | null {
  return overrides?.issuer ?? mcpConfig().issuer;
}

// ------------------------------------------------------------------ helpers

export function parseScopes(raw: unknown): McpScope[] {
  const s = typeof raw === 'string' ? raw.split(/\s+/) : Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
  return [...new Set(s.filter(isMcpScope))].sort((a, b) => MCP_SCOPES.indexOf(a) - MCP_SCOPES.indexOf(b));
}

const fingerprint = (token: string) => createHash('sha256').update(token).digest('base64url').slice(0, 22);

const JWT_MESSAGES: Record<string, string> = {
  expired: 'The access token expired',
  bad_audience: 'The access token was not issued for this resource',
  bad_issuer: 'The access token was issued by an unexpected authorization server',
  bad_signature: 'The access token signature is invalid',
  unknown_key: 'The access token was signed with an unknown key',
  unsupported_alg: 'The access token uses an unsupported algorithm',
  malformed: 'The access token is malformed',
  bad_iat: 'The access token is not valid yet',
};

const invalid = (description: string): AuthOutcome => ({ ok: false, status: 401, error: 'invalid_token', description });

/** Verify the Authorization header. Never logs or returns the token. */
export async function authenticateMcpRequest(authorization: string | null, db: Queryable = getPool()): Promise<AuthOutcome | null> {
  if (!authorization) return null; // no credentials ⇒ 401 challenge without error code (RFC 6750 §3.1)
  const m = /^Bearer\s+([A-Za-z0-9._~+/=-]+)$/i.exec(authorization.trim());
  if (!m || m[1]!.length > 8192) return { ok: false, status: 400, error: 'invalid_request', description: 'Use Authorization: Bearer <access token>' };
  const token = m[1]!;
  if (token.startsWith('sl_live_')) return authenticateKey(authorization, token, db);
  return authenticateJwt(token, db);
}

async function authenticateKey(authorization: string, token: string, db: Queryable): Promise<AuthOutcome> {
  const p = await authenticateApiKey(authorization, db);
  if (!p) return invalid('Invalid, expired or revoked API key');
  const sa = await maybeOne<{ owner_user_id: string; name: string }>(db, `SELECT owner_user_id, name FROM service_accounts WHERE id=$1`, [p.serviceAccountId]);
  if (!sa) return invalid('Invalid, expired or revoked API key');
  return {
    ok: true,
    principal: {
      kind: 'service_account', key: `k:${p.keyId}`, userId: null, email: `service-account:${p.serviceAccountId}`, name: sa.name,
      serviceAccountId: p.serviceAccountId, apiKeyId: p.keyId, workspaceId: p.workspaceId, clientId: p.prefix, clientKind: 'api_key', issuer: null,
      tokenScopes: [...MCP_SCOPES], assurance: { mfaVerified: false, authTime: null }, expiresAt: null, tokenFingerprint: fingerprint(token),
    },
  };
}

async function authenticateJwt(token: string, db: Queryable): Promise<AuthOutcome> {
  const issuer = expectedIssuer();
  if (!issuer) return invalid('This server has no authorization server configured');
  const cfg = mcpConfig();
  let claims: Record<string, unknown>;
  try {
    ({ claims } = await verifyJwt(token, { keys: keysFor(issuer), issuer, audience: cfg.resourceUrl, clockSkewS: 30 }));
  } catch (err) {
    if (err instanceof JwtError) return invalid(JWT_MESSAGES[err.code] ?? 'The access token is invalid');
    log.warn('mcp_jwks_unavailable', { err: err as Error });
    return invalid('The access token could not be verified');
  }
  if (typeof claims.exp !== 'number') return invalid('The access token has no expiry');
  if (typeof claims.nbf === 'number' && claims.nbf - 30 > Date.now() / 1000) return invalid('The access token is not valid yet');
  // Only access tokens: never ID/refresh/logout tokens (Keycloak typ claim; RFC 9068 typ header handled by issuer config).
  if (claims.typ !== undefined && !['Bearer', 'at+jwt', 'application/at+jwt'].includes(String(claims.typ))) return invalid('Only access tokens are accepted');
  const clientId = typeof claims.azp === 'string' ? claims.azp : typeof claims.client_id === 'string' ? claims.client_id : null;
  if (!clientId || clientId.length > 300) return invalid('The access token has no client id');
  const sub = typeof claims.sub === 'string' ? claims.sub : null;
  if (!sub) return invalid('The access token has no subject');
  const user = await maybeOne<{ id: string; email: string; name: string | null; disabled_at: Date | null }>(db,
    `SELECT id, email, name, disabled_at FROM users WHERE oidc_issuer=$1 AND oidc_subject=$2`, [issuer, sub]);
  if (!user || user.disabled_at) return invalid('Sign in to Relay with this account before connecting an MCP client');
  const acr = typeof claims.acr === 'string' ? claims.acr : null;
  const amr = Array.isArray(claims.amr) ? claims.amr.filter((x): x is string => typeof x === 'string') : [];
  const authTime = typeof claims.auth_time === 'number' ? new Date(claims.auth_time * 1000).toISOString() : null;
  return {
    ok: true,
    principal: {
      kind: 'user', key: `u:${user.id}:${clientId}`, userId: user.id, email: user.email, name: user.name, serviceAccountId: null, apiKeyId: null,
      workspaceId: null, clientId, clientKind: 'oauth', issuer, tokenScopes: parseScopes(claims.scope),
      assurance: { mfaVerified: acr === 'mfa' && amr.some((x) => SECOND_FACTOR_AMR.has(x)), authTime },
      expiresAt: claims.exp, tokenFingerprint: fingerprint(token),
    },
  };
}

// ------------------------------------------------------------------ registry admission

export interface ClientRow {
  id: string; workspace_id: string | null; owner_user_id: string; kind: 'oauth' | 'api_key'; client_id: string; issuer: string | null;
  service_account_id: string | null; api_key_id: string | null; name: string; requested_scopes: string[]; granted_scopes: string[];
  brand_ids: string[] | null; status: 'pending' | 'active' | 'revoked'; consented_at: Date | null; created_at: Date;
  last_activity_at: Date | null; last_tool: string | null; revoked_at: Date | null;
}

/**
 * Admit an authenticated principal against the client registry (once per HTTP request).
 * OAuth: creates a pending registration on first sight; rejects a client whose every registration is revoked.
 * API keys: the key's own registration is created active (workspace = key's); revoked ⇒ rejected.
 */
export async function admitPrincipal(p: McpPrincipal, db: Queryable = getPool()): Promise<AuthOutcome> {
  if (p.kind === 'service_account') {
    const rows = await many<ClientRow>(db, `SELECT * FROM mcp_clients WHERE kind='api_key' AND api_key_id=$1`, [p.apiKeyId]);
    if (rows.some((r) => r.status === 'revoked') && !rows.some((r) => r.status === 'active')) return invalid('MCP access for this API key was revoked in Relay');
    if (!rows.length) {
      const sa = await maybeOne<{ owner_user_id: string }>(db, `SELECT owner_user_id FROM service_accounts WHERE id=$1`, [p.serviceAccountId]);
      if (!sa) return invalid('Invalid, expired or revoked API key');
      await db.query(
        `INSERT INTO mcp_clients(workspace_id, owner_user_id, kind, client_id, service_account_id, api_key_id, name, requested_scopes, granted_scopes, status, consented_at)
         VALUES ($1,$2,'api_key',$3,$4,$5,$6,$7,$7,'active',now()) ON CONFLICT DO NOTHING`,
        [p.workspaceId, sa.owner_user_id, p.clientId, p.serviceAccountId, p.apiKeyId, `API key ${p.clientId}`.slice(0, 200), [...MCP_SCOPES]]);
    }
    return { ok: true, principal: p };
  }
  const rows = await many<ClientRow>(db, `SELECT * FROM mcp_clients WHERE kind='oauth' AND client_id=$1 AND owner_user_id=$2`, [p.clientId, p.userId]);
  const live = rows.filter((r) => r.status !== 'revoked');
  if (!live.length && rows.length) return invalid('MCP access for this client was revoked in Relay. Allow it again in Settings > Developer > MCP.');
  if (!live.length) {
    await db.query(
      `INSERT INTO mcp_clients(owner_user_id, kind, client_id, issuer, name, requested_scopes, status) VALUES ($1,'oauth',$2,$3,$4,$5,'pending') ON CONFLICT DO NOTHING`,
      [p.userId, p.clientId, p.issuer, p.clientId.slice(0, 200), p.tokenScopes]);
  } else {
    // Keep the pending registration's requested scopes in step with what the client actually asks for.
    await db.query(`UPDATE mcp_clients SET requested_scopes=$2 WHERE id=$1 AND status='pending' AND requested_scopes <> $2`,
      [live.find((r) => r.status === 'pending')?.id ?? null, p.tokenScopes]);
  }
  return { ok: true, principal: p };
}

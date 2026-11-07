// MCP server configuration (V3 §13). Read from the environment with safe defaults derived from APP_BASE_URL and
// OIDC_ISSUER; no secrets live here. Production refuses an insecure resource URL.
//   MCP_RESOURCE_URL        canonical MCP resource URI (RFC 8707 / RFC 9728 `resource`); default <APP_BASE_URL>/mcp
//   MCP_AUTH_ISSUER         authorization server issuer (Keycloak realm); default OIDC_ISSUER
//   MCP_ALLOWED_ORIGINS     extra allowed browser Origins (comma separated); requests WITHOUT Origin are allowed
//   MCP_ALLOWED_HOSTS       extra allowed Host header values (comma separated)
//   MCP_PUBLIC_CLIENT_ID    pre-registered public OAuth client for MCP clients (Keycloak); default relay-mcp
//   MCP_DCR_ENABLED         "true" when the authorization server accepts dynamic client registration for MCP clients
import { AppError } from '@social-lite/core';
import { config } from '../config.js';

export interface McpConfig {
  resourceUrl: string;
  endpointPath: string;
  issuer: string | null;
  prmUrl: string;
  prmRootUrl: string;
  allowedOrigins: Set<string>;
  allowedHosts: Set<string>;
  publicClientId: string | null;
  dcrEnabled: boolean;
  allowInsecureIssuer: boolean;
}

const list = (v: string | undefined) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

let cached: { key: string; value: McpConfig } | undefined;

export function mcpConfig(env: NodeJS.ProcessEnv = process.env): McpConfig {
  const c = config();
  const key = [c.APP_BASE_URL, c.OIDC_ISSUER, env.MCP_RESOURCE_URL, env.MCP_AUTH_ISSUER, env.MCP_ALLOWED_ORIGINS, env.MCP_ALLOWED_HOSTS,
    env.MCP_PUBLIC_CLIENT_ID, env.MCP_DCR_ENABLED, c.APP_ENV].join('|');
  if (cached?.key === key) return cached.value;
  const base = new URL(c.APP_BASE_URL);
  const resource = new URL(env.MCP_RESOURCE_URL ?? `${base.origin}/mcp`);
  resource.hash = '';
  if (c.APP_ENV === 'production' && resource.protocol !== 'https:') throw new AppError('internal', 'MCP_RESOURCE_URL must use https in production');
  const resourceUrl = resource.toString().replace(/\/$/, '');
  const endpointPath = resource.pathname.replace(/\/$/, '') || '/';
  const prmPath = endpointPath === '/' ? '' : endpointPath;
  const value: McpConfig = {
    resourceUrl,
    endpointPath,
    issuer: env.MCP_AUTH_ISSUER ?? c.OIDC_ISSUER ?? null,
    // RFC 9728 §3.1: path-inserted well-known URI for a resource with a path component (+ root fallback).
    prmUrl: `${resource.origin}/.well-known/oauth-protected-resource${prmPath}`,
    prmRootUrl: `${resource.origin}/.well-known/oauth-protected-resource`,
    allowedOrigins: new Set([base.origin, resource.origin, ...list(env.MCP_ALLOWED_ORIGINS)]),
    allowedHosts: new Set([base.host, resource.host, ...list(env.MCP_ALLOWED_HOSTS)].map((h) => h.toLowerCase())),
    publicClientId: env.MCP_PUBLIC_CLIENT_ID === '' ? null : (env.MCP_PUBLIC_CLIENT_ID ?? 'relay-mcp'),
    dcrEnabled: env.MCP_DCR_ENABLED === 'true',
    allowInsecureIssuer: c.OIDC_ALLOW_INSECURE_HTTP && c.APP_ENV !== 'production',
  };
  cached = { key, value };
  return value;
}

/** Limits (rate / result size / cost). */
export const MCP_LIMITS = {
  /** Per principal: 120 burst, 2 calls/s sustained (HTTP requests to /mcp). */
  rate: { capacity: 120, refillPerSecond: 2 },
  /** Mutating tools per principal: 30 burst, 1 per 2 s. */
  mutationRate: { capacity: 30, refillPerSecond: 0.5 },
  /** Exports per principal: 5 per hour. */
  exportRate: { capacity: 5, refillPerSecond: 5 / 3600 },
  maxRequestBytes: 256 * 1024,
  /** Serialized structured result bound per tool call. */
  maxResultBytes: 200 * 1024,
  maxPageSize: 50,
  maxCalendarDays: 31,
  maxAnalyticsDays: 92,
  maxSessions: 2000,
  maxSessionsPerPrincipal: 20,
  sessionIdleMs: 30 * 60_000,
  intentTtlMs: 30 * 60_000,
  maxToolInputElements: 2000,
} as const;

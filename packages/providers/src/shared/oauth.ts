// Shared OAuth 2.0 helpers for the V3 connectors.
import type { DestinationCandidate, FinalizedDestination, OAuthTokenSet, ProviderCredentials, ConnectionHealth, Provider } from '@social-lite/core';

/** Connection-setup / refresh failure with a SAFE message. permanent=true ⇒ re-authorization is required. */
export class OAuthFlowError extends Error {
  constructor(public readonly provider: Provider, public readonly code: string, message: string, public readonly permanent: boolean) {
    super(message);
    this.name = 'OAuthFlowError';
  }
}

export interface RawTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  refresh_token_expires_in?: number;
  refresh_expires_in?: number;
  scope?: string;
  [k: string]: unknown;
}

export function tokenSetFrom(raw: RawTokenResponse, nowMs: number, scopeSeparator: RegExp, fallbackScope?: string): OAuthTokenSet {
  const scope = typeof raw.scope === 'string' ? raw.scope : (fallbackScope ?? '');
  return {
    accessToken: String(raw.access_token ?? ''),
    refreshToken: typeof raw.refresh_token === 'string' && raw.refresh_token ? raw.refresh_token : null,
    expiresAt: typeof raw.expires_in === 'number' ? new Date(nowMs + raw.expires_in * 1000).toISOString() : null,
    scopes: scope.split(scopeSeparator).map((s) => s.trim()).filter(Boolean),
  };
}

export function refreshExpiryFrom(raw: RawTokenResponse, nowMs: number): string | null {
  const s = raw.refresh_token_expires_in ?? raw.refresh_expires_in;
  return typeof s === 'number' ? new Date(nowMs + s * 1000).toISOString() : null;
}

export function oauth2Credentials(t: OAuthTokenSet, scopeJoin = ' '): ProviderCredentials {
  return { kind: 'oauth2', accessToken: t.accessToken, refreshToken: t.refreshToken ?? null, expiresAt: t.expiresAt ?? null, scope: t.scopes.join(scopeJoin) };
}

/** Granted scopes from stored credentials (empty when the provider did not report scopes). */
export function grantedScopes(credentials: ProviderCredentials, separator: RegExp = /[\s,]+/): string[] {
  return credentials.kind === 'oauth2' && credentials.scope ? credentials.scope.split(separator).filter(Boolean) : [];
}

/** Missing required scopes; unknown grants (provider returned none) are not treated as missing. */
export function missingScopes(required: readonly string[], granted: readonly string[]): string[] {
  if (!granted.length) return [];
  return required.filter((s) => !granted.includes(s));
}

export function standardFinalize(p: {
  provider: Provider; label: string; tokens: OAuthTokenSet; candidate: DestinationCandidate; nowIso: string;
  required: readonly string[]; metadata: Record<string, unknown>; scopeJoin?: string; refreshExpiresAt?: string | null;
}): FinalizedDestination {
  const missing = missingScopes(p.required, p.tokens.scopes);
  const health: ConnectionHealth = missing.length
    ? { status: 'missing_permission', checkedAt: p.nowIso, missingPermissions: missing, message: `${p.label} did not grant: ${missing.join(', ')}. Click Reconnect and approve all requested permissions.` }
    : { status: 'ready', checkedAt: p.nowIso, message: `Connected as ${p.candidate.displayName}.` };
  return {
    providerAccountId: p.candidate.providerAccountId,
    displayName: p.candidate.displayName,
    username: p.candidate.username ?? null,
    credentials: oauth2Credentials(p.tokens, p.scopeJoin),
    grantedScopes: p.tokens.scopes,
    expiresAt: p.tokens.expiresAt ?? null,
    refreshExpiresAt: p.refreshExpiresAt ?? null,
    metadata: p.metadata,
    health,
  };
}

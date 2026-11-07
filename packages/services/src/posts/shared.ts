// Shared loaders for posts/scheduling/engine: connections, capabilities, media facts.
import { createHash } from 'node:crypto';
import type { ChannelCapabilities, ConnectionStatus, MediaFacts, Provider, ResolvedVariant } from '@social-lite/core';
import { many, type Queryable } from '@social-lite/db';
import { getAdapter } from '@social-lite/providers';
import { stableStringify } from '../idempotency.js';
import { publishFacts } from '../media/assets.js';

export interface ConnectionRow {
  id: string; workspace_id: string; brand_id: string; provider: Provider; provider_account_id: string;
  display_name: string; username: string | null; status: ConnectionStatus; is_mock: boolean; paused: boolean;
  capabilities: Partial<ChannelCapabilities>; metadata: Record<string, unknown>; throttled_until: Date | null;
  disconnected_at: Date | null; health_detail: Record<string, unknown>; health_checked_at: Date | null; created_at: Date;
}

export async function brandConnections(db: Queryable, workspaceId: string, brandId: string, includeDisconnected = false): Promise<ConnectionRow[]> {
  return many<ConnectionRow>(db,
    `SELECT id, workspace_id, brand_id, provider, provider_account_id, display_name, username, status, is_mock, paused,
            capabilities, metadata, throttled_until, disconnected_at, health_detail, health_checked_at, created_at
       FROM connections WHERE workspace_id=$1 AND brand_id=$2 ${includeDisconnected ? '' : 'AND disconnected_at IS NULL'}
      ORDER BY provider, display_name`, [workspaceId, brandId]);
}

/** Capabilities for validation. Prefer the adapter's current constraints; fall back to the stored record. */
export function capabilitiesFor(c: ConnectionRow): ChannelCapabilities | null {
  try {
    return getAdapter(c.provider).capabilities({
      id: c.id, provider: c.provider, providerAccountId: c.provider_account_id, displayName: c.display_name,
      username: c.username, metadata: c.metadata, isMock: c.is_mock,
    });
  } catch {
    const stored = c.capabilities as ChannelCapabilities;
    return stored?.constraints ? stored : null;
  }
}

/**
 * Facts used by validation: the publish derivative's dimensions/type when available.
 * V1.1: delegated to the media service so videos carry kind/duration/codecs (same image semantics).
 */
export async function mediaFacts(db: Queryable, workspaceId: string, assetIds: string[]): Promise<MediaFacts[]> {
  return publishFacts(db, workspaceId, assetIds);
}

export function contentHash(baseText: string, baseLink: string | null, baseAssetIds: string[], variants: ResolvedVariant[]): string {
  const v = [...variants].sort((a, b) => a.connectionId.localeCompare(b.connectionId));
  return createHash('sha256').update(stableStringify({ baseText, baseLink, baseAssetIds, v })).digest('hex');
}

export function scheduleFingerprint(p: { revisionId: string; connectionIds: string[]; dueAt: Date | null; publishBefore: Date | null; immediate: boolean }): string {
  return createHash('sha256').update(stableStringify({
    r: p.revisionId, c: [...p.connectionIds].sort(), d: p.immediate ? 'on-approval' : p.dueAt?.toISOString(),
    b: p.immediate ? null : p.publishBefore?.toISOString(),
  })).digest('hex').slice(0, 32);
}

export function excerpt(text: string, n = 140): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

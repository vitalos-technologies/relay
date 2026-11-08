// Content Hub persistence helpers shared by imports, refresh and rows: immutable snapshots (deduplicated by
// fingerprint, diffed against the previous snapshot), draft creation through the normal post model (version history,
// audit) and source→post links. Imported text is stored as plain draft text — untrusted content, never instructions.
import { AppError, draftContentSchema, type DraftContent } from '@social-lite/core';
import type { ImportWarning, NormalizedSection } from '@social-lite/core/contracts/content-hub';
import { many, maybeOne, one, type Queryable } from '@social-lite/db';
import type { Ctx } from '../context.js';
import { audit } from '../audit.js';
import { recordVersion } from '../posts/versions.js';
import { LIMITS } from './config.js';
import { diffSnapshots, sha256Hex } from './normalize.js';

export interface SnapshotInput {
  workspaceId: string; brandId: string; itemId: string; kind: 'media' | 'document' | 'notion_page' | 'notion_row'; fingerprint: string;
  title: string | null; content: Record<string, unknown>; warnings: ImportWarning[]; incomplete: boolean; version: string | null; modifiedAt: string | null;
  sourceChecksum?: string | null; checksum?: string | null; assetId?: string | null; importedBy: string | null;
}

export interface SnapshotRow { id: string; seq: number; fingerprint: string; content: { title?: string; sections?: NormalizedSection[] } & Record<string, unknown>; asset_id: string | null }

/**
 * Create the next immutable snapshot for an item — or reuse the latest when the fingerprint is unchanged (retries and
 * re-imports never duplicate). Serialized per item by locking the item row. Document snapshots carry a diff.
 */
export async function createSnapshot(tx: Queryable, p: SnapshotInput): Promise<{ id: string; seq: number; reused: boolean; previous: SnapshotRow | null }> {
  await tx.query(`SELECT 1 FROM source_items WHERE id=$1 AND workspace_id=$2 FOR UPDATE`, [p.itemId, p.workspaceId]);
  const prev = await maybeOne<SnapshotRow>(tx,
    `SELECT id, seq, fingerprint, content, asset_id FROM source_snapshots WHERE source_item_id=$1 ORDER BY seq DESC LIMIT 1`, [p.itemId]);
  if (prev && prev.fingerprint === p.fingerprint) return { id: prev.id, seq: prev.seq, reused: true, previous: prev };
  const sections = (p.content.sections ?? null) as NormalizedSection[] | null;
  const id = (await one<{ id: string }>(tx, `SELECT gen_random_uuid() AS id`)).id;
  const diff = prev && sections && Array.isArray(prev.content.sections)
    ? diffSnapshots({ id: prev.id, sections: prev.content.sections }, { id, sections })
    : prev && p.kind === 'media' ? { from_snapshot_id: prev.id, to_snapshot_id: id, changed: true, media_changed: true, from_asset_id: prev.asset_id, to_asset_id: p.assetId ?? null } : null;
  const seq = (prev?.seq ?? 0) + 1;
  await tx.query(
    `INSERT INTO source_snapshots(id, workspace_id, brand_id, source_item_id, seq, content_kind, fingerprint, checksum_sha256, source_checksum, source_version,
            source_modified_at, title, content, warnings, incomplete, asset_id, imported_by, diff_from_snapshot_id, diff)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
    [id, p.workspaceId, p.brandId, p.itemId, seq, p.kind, p.fingerprint, p.checksum ?? null, p.sourceChecksum ?? null, p.version, p.modifiedAt,
      p.title?.slice(0, 500) ?? null, JSON.stringify(p.content), JSON.stringify(p.warnings), p.incomplete, p.assetId ?? null, p.importedBy, prev?.id ?? null, diff ? JSON.stringify(diff) : null]);
  await tx.query(
    `UPDATE source_items SET last_snapshot_id=$2, last_synced_at=now(), source_version=coalesce($3, source_version), source_modified_at=coalesce($4, source_modified_at),
            source_checksum=coalesce($5, source_checksum), change_detected_at=NULL, updated_at=now() WHERE id=$1`,
    [p.itemId, id, p.version, p.modifiedAt, p.sourceChecksum ?? null]);
  return { id, seq, reused: false, previous: prev };
}

export interface DraftInput {
  brandId: string; title: string; text: string; assetIds?: string[]; connectionIds?: string[]; campaignId?: string | null; dueAt?: Date | null;
  source: { kind: 'content_hub'; source: 'google' | 'notion'; item_id: string; snapshot_id: string; import_id: string | null; external_ref?: string | null; external_status?: string | null };
}

export const draftTextHash = (text: string) => sha256Hex(text);

export function clampDraftText(text: string): { text: string; truncated: boolean } {
  return text.length > LIMITS.draftTextChars ? { text: text.slice(0, LIMITS.draftTextChars), truncated: true } : { text, truncated: false };
}

/** Insert a new DRAFT post (never submitted/approved/scheduled — imports cannot grant publishing). */
export async function insertDraft(tx: Queryable, ctx: Ctx, d: DraftInput): Promise<string> {
  const assetIds = [...new Set(d.assetIds ?? [])].slice(0, 10);
  const connIds = [...new Set(d.connectionIds ?? [])];
  if (assetIds.length) {
    const ok = await many<{ id: string }>(tx, `SELECT id FROM assets WHERE workspace_id=$1 AND brand_id=$2 AND id = ANY($3::uuid[]) AND status IN ('ready','quarantined')`,
      [ctx.access.workspaceId, d.brandId, assetIds]);
    if (ok.length !== assetIds.length) throw new AppError('validation_failed', 'An imported file is not available in this brand’s library.');
  }
  if (connIds.length) {
    const ok = await many<{ id: string }>(tx, `SELECT id FROM connections WHERE workspace_id=$1 AND brand_id=$2 AND id = ANY($3::uuid[]) AND disconnected_at IS NULL`,
      [ctx.access.workspaceId, d.brandId, connIds]);
    if (ok.length !== connIds.length) throw new AppError('validation_failed', 'One or more destinations do not belong to this brand', { connection_ids: 'Choose destinations connected to this brand' });
  }
  const draft: DraftContent = draftContentSchema.parse({
    baseText: clampDraftText(d.text).text, baseLink: null, baseAssetIds: assetIds,
    variants: connIds.map((connectionId) => ({ connectionId, inheritText: true, inheritMedia: true })),
  }) as DraftContent;
  const title = d.title.replace(/\s+/g, ' ').trim().slice(0, 200) || 'Imported draft';
  const post = await one<{ id: string }>(tx,
    `INSERT INTO posts(workspace_id, brand_id, created_by, updated_by, title, draft, source, campaign_id, due_at) VALUES ($1,$2,$3,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [ctx.access.workspaceId, d.brandId, ctx.actor.userId, title, JSON.stringify(draft), JSON.stringify(d.source), d.campaignId ?? null, d.dueAt ?? null]);
  await recordVersion(tx, ctx, { postId: post.id, version: 1, baseVersion: 1, kind: 'created', title, draft });
  await audit(tx, { workspaceId: ctx.access.workspaceId, brandId: d.brandId, actorUserId: ctx.actor.userId, action: 'post.created', resourceType: 'post', resourceId: post.id,
    diff: { origin: 'content_hub', source: d.source.source, source_item_id: d.source.item_id, snapshot_id: d.source.snapshot_id }, correlationId: ctx.correlationId });
  return post.id;
}

export async function linkPost(tx: Queryable, ctx: Ctx, p: { brandId: string; postId: string; itemId: string; snapshotId: string; importId: string | null; sectionIds: string[]; text: string }): Promise<void> {
  await tx.query(
    `INSERT INTO source_post_links(workspace_id, brand_id, post_id, source_item_id, snapshot_id, import_id, section_ids, imported_hash) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [ctx.access.workspaceId, p.brandId, p.postId, p.itemId, p.snapshotId, p.importId, p.sectionIds, draftTextHash(clampDraftText(p.text).text)]);
}

/** Find-or-create a campaign by name in the brand (names come from source data: only a label, never an id). */
export async function campaignByName(tx: Queryable, ctx: Ctx, brandId: string, name: string): Promise<string> {
  const clean = name.replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!clean) throw new AppError('validation_failed', 'Campaign name is empty.');
  const hit = await maybeOne<{ id: string }>(tx, `SELECT id FROM campaigns WHERE workspace_id=$1 AND brand_id=$2 AND lower(name)=lower($3) AND archived_at IS NULL LIMIT 1`,
    [ctx.access.workspaceId, brandId, clean]);
  if (hit) return hit.id;
  const r = await one<{ id: string }>(tx, `INSERT INTO campaigns(workspace_id, brand_id, name, created_by) VALUES ($1,$2,$3,$4) RETURNING id`,
    [ctx.access.workspaceId, brandId, clean, ctx.actor.userId]);
  await audit(tx, { workspaceId: ctx.access.workspaceId, brandId, actorUserId: ctx.actor.userId, action: 'campaign.created', resourceType: 'campaign', resourceId: r.id,
    diff: { name: clean, origin: 'content_hub' }, correlationId: ctx.correlationId });
  return r.id;
}

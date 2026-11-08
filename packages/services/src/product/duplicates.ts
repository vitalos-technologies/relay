// Duplicate / collision WARNING (V2 §7). Flags similar content (normalised text similarity and/or the
// same media) going to the SAME destination within the brand's window (brands.duplicate_window_hours).
// This is advisory only and is unrelated to delivery idempotency (which guarantees one provider post
// per delivery): a warning never blocks — the composer requires the user to acknowledge it first.
import type { Queryable } from '@social-lite/db';
import { many } from '@social-lite/db';
import { excerpt } from '../posts/shared.js';

export const DUPLICATE_SIMILARITY_THRESHOLD = 0.8;

/** Lowercase, NFKC, URLs reduced to host+path, punctuation/emoji variation removed, whitespace collapsed. */
export function normaliseForDuplicate(text: string): string {
  return text.normalize('NFKC').toLowerCase()
    .replace(/https?:\/\/(www\.)?([^\s?#]+)[^\s]*/g, ' $2 ')
    .replace(/[^\p{L}\p{N}\s/._-]+/gu, ' ')
    .replace(/[._-]+(\s|$)/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function trigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  const t = ` ${s} `;
  for (let i = 0; i + 3 <= t.length; i++) {
    const g = t.slice(i, i + 3);
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}

/** Sørensen–Dice similarity on character trigrams of the normalised texts (0..1). */
export function textSimilarity(a: string, b: string): number {
  const na = normaliseForDuplicate(a);
  const nb = normaliseForDuplicate(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const ga = trigrams(na);
  const gb = trigrams(nb);
  let inter = 0; let total = 0;
  for (const [, n] of ga) total += n;
  for (const [g, n] of gb) { total += n; inter += Math.min(n, ga.get(g) ?? 0); }
  return total ? (2 * inter) / total : 0;
}

export interface DuplicateCandidateInput { connectionId: string; text: string; assetIds: string[] }

export interface DuplicateMatch {
  connection_id: string; other_post_id: string; other_title: string | null; other_excerpt: string; other_at: string; other_state: string;
  similarity: number; same_media: boolean; reason: 'similar_text' | 'same_media' | 'both';
}

/**
 * Find collisions for the given destinations around `at` (±window). Excludes the post itself and
 * cancelled/failed/expired/superseded work. Caller has already authorized the post's brand; all
 * candidates are on the same connection (hence the same brand and workspace).
 */
export async function findDuplicates(db: Queryable, p: { workspaceId: string; postId: string; at: Date; windowHours: number; targets: DuplicateCandidateInput[]; threshold?: number }): Promise<DuplicateMatch[]> {
  if (!p.windowHours || !p.targets.length) return [];
  const threshold = p.threshold ?? DUPLICATE_SIMILARITY_THRESHOLD;
  const from = new Date(p.at.getTime() - p.windowHours * 3600_000);
  const to = new Date(p.at.getTime() + p.windowHours * 3600_000);
  const conns = p.targets.map((t) => t.connectionId);
  const rows = await many<{ connection_id: string; post_id: string; title: string | null; rendered_text: string; asset_ids: string[]; at: Date; state: string }>(db,
    `SELECT * FROM (
       SELECT DISTINCT ON (d.post_id, d.connection_id) d.connection_id, d.post_id, p.title, v.rendered_text, v.asset_ids,
              coalesce(d.published_at, d.due_at) AS at, d.state::text AS state
         FROM deliveries d JOIN variants v ON v.id = d.variant_id JOIN posts p ON p.id = d.post_id JOIN schedules s ON s.id = d.schedule_id
        WHERE d.workspace_id = $1 AND d.connection_id = ANY($2::uuid[]) AND d.post_id <> $3
          AND d.state NOT IN ('cancelled','failed','expired') AND s.status <> 'superseded'
          AND coalesce(d.published_at, d.due_at) BETWEEN $4 AND $5
        ORDER BY d.post_id, d.connection_id, d.created_at DESC
     ) x
     UNION ALL
     SELECT v.connection_id, s.post_id, p.title, v.rendered_text, v.asset_ids, s.due_at, 'pending_approval'
       FROM schedules s JOIN variants v ON v.revision_id = s.revision_id JOIN posts p ON p.id = s.post_id
      WHERE s.workspace_id = $1 AND v.connection_id = ANY($2::uuid[]) AND s.post_id <> $3 AND s.status = 'pending_approval'
        AND s.due_at BETWEEN $4 AND $5
     LIMIT 1000`, [p.workspaceId, conns, p.postId, from, to]);
  if (!rows.length) return [];
  // Same media = same asset or byte-identical re-upload (checksum).
  const allAssets = [...new Set([...p.targets.flatMap((t) => t.assetIds), ...rows.flatMap((r) => r.asset_ids ?? [])])];
  const sums = allAssets.length ? await many<{ id: string; checksum_sha256: string | null }>(db,
    `SELECT id, checksum_sha256 FROM assets WHERE workspace_id = $1 AND id = ANY($2::uuid[])`, [p.workspaceId, allAssets]) : [];
  const keyOf = (id: string) => sums.find((s) => s.id === id)?.checksum_sha256 ?? id;
  const out: DuplicateMatch[] = [];
  for (const t of p.targets) {
    const mine = new Set(t.assetIds.map(keyOf));
    for (const r of rows.filter((x) => x.connection_id === t.connectionId)) {
      const similarity = Math.round(textSimilarity(t.text, r.rendered_text) * 100) / 100;
      const sameMedia = mine.size > 0 && (r.asset_ids ?? []).some((a) => mine.has(keyOf(a)));
      const similar = similarity >= threshold;
      if (!similar && !sameMedia) continue;
      out.push({ connection_id: t.connectionId, other_post_id: r.post_id, other_title: r.title, other_excerpt: excerpt(r.rendered_text, 100),
        other_at: r.at.toISOString(), other_state: r.state, similarity, same_media: sameMedia, reason: similar && sameMedia ? 'both' : similar ? 'similar_text' : 'same_media' });
    }
  }
  return out.sort((a, b) => b.similarity - a.similarity);
}

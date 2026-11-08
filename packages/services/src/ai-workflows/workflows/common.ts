// Shared pieces of the V5 workflows: input parsing, saving drafts through the posts service, provider-specific
// drafting instructions and hashes binding prepared actions to exact content.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AppError, PROVIDER_LABEL, type Provider } from '@social-lite/core';
import { getPool } from '@social-lite/db';
import { audit } from '../../audit.js';
import { createPost, validatePost } from '../../posts/service.js';
import { stableStringify } from '../../idempotency.js';
import type { StepCtx } from '../engine.js';
import type { Destination, SourceRef } from '../sources.js';

export const uuid = z.string().uuid();
export const sourceRefSchema = z.object({ kind: z.enum(['source_item', 'knowledge', 'post', 'attachment']), id: uuid }).strict();
export const commonInput = {
  brand_id: uuid,
  knowledge_ids: z.array(uuid).max(10).optional(),
  attachment_ids: z.array(uuid).max(5).optional(),
};

export const src = (s: StepCtx) => s.input.source as SourceRef;
export const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

export function channelTask(d: Destination, what: string): string {
  return `${what}
Write ONE social post for ${PROVIDER_LABEL[d.provider]} (${d.display_name}). Return it as one suggestion of kind "copy".
- Keep it within ${d.max_length} characters (aim for well under the limit on ${d.provider === 'x' || d.provider === 'bluesky' || d.provider === 'threads' ? 'short-form networks' : 'this network'}).
- ${d.requires_media ? 'This network needs an image or video: write the caption and mention in "uncertainty" which visual is needed.' : 'Text-only posts are allowed.'}
- Follow the brand voice source when present. Use only facts from the sources; do not invent offers, prices, dates or links.`;
}

export interface SavedDraft { post_id: string; issues: Array<{ severity: 'block' | 'warn'; message: string }> }

/** Save one draft through the normal posts service (drafts.edit; idempotent per run/step/item). */
export async function saveDraftPost(s: StepCtx, item: string, p: { title: string; text: string; connectionIds: string[] }): Promise<SavedDraft> {
  const created = await createPost(s.ctx, s.run.brand_id, {
    title: p.title.slice(0, 200),
    draft: { baseText: p.text, baseLink: null, baseAssetIds: [], variants: p.connectionIds.map((connectionId) => ({ connectionId, inheritText: true, inheritMedia: true })) },
  }, s.idem(item));
  await audit(getPool(), { workspaceId: s.run.workspace_id, brandId: s.run.brand_id, actorUserId: s.ctx.actor.userId, action: 'ai.workflow_record_created', resourceType: 'post', resourceId: created.id,
    diff: { run_id: s.run.id, workflow: s.run.task, step: s.step.key }, correlationId: s.ctx.correlationId });
  let issues: SavedDraft['issues'] = [];
  try {
    const v = await validatePost(s.ctx, created.id, p.connectionIds);
    issues = v.issues.slice(0, 5).map((i) => ({ severity: 'warn' as const, message: i.message }));
  } catch { /* validation is advisory here */ }
  return { post_id: created.id, issues };
}

export function hashOf(v: unknown): string {
  return createHash('sha256').update(stableStringify(v)).digest('hex').slice(0, 40);
}

export function requireReadyDestinations(all: Destination[], wanted: string[]): { ready: Destination[]; notReady: Destination[] } {
  // Nothing chosen: one ready account per network, at most six (a draft per channel, not per duplicate account).
  const firstPerNetwork = all.filter((d) => d.ready).filter((d, i, list) => list.findIndex((x) => x.provider === d.provider) === i).slice(0, 6);
  const chosen = wanted.length ? all.filter((d) => wanted.includes(d.id)) : firstPerNetwork;
  return { ready: chosen.filter((d) => d.ready), notReady: chosen.filter((d) => !d.ready) };
}

export const providerLabel = (p: Provider) => PROVIDER_LABEL[p];

export function assertText(t: string | null | undefined, what: string): string {
  if (!t?.trim()) throw new AppError('invalid_state', `${what} is empty.`);
  return t;
}

/** Local wall time "YYYY-MM-DDTHH:mm" for an instant in a zone. */
export function localInput(at: Date, tz: string): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(at).map((x) => [x.type, x.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

export function humanTime(local: string, tz: string): string {
  const [d, t] = local.split('T');
  const date = new Date(`${d}T12:00:00Z`);
  return `${date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })} ${t} (${tz})`;
}

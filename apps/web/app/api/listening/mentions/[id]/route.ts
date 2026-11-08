// GET /api/listening/mentions/:id · PATCH { sentiment: label|null } | { excluded, reason } (listening.manage)
import { z } from 'zod';
import { correctSentiment, getMention, setExcluded } from '@social-lite/services/listening/index';
import { parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const patch = z.union([
  z.object({ sentiment: z.enum(['positive', 'negative', 'neutral', 'mixed']).nullable() }).strict(),
  z.object({ excluded: z.boolean(), reason: z.string().trim().max(200).nullable().optional() }).strict(),
]);

export const GET = route<{ id: string }>(async ({ ctx, params }) => getMention(ctx, params.id));
export const PATCH = route<{ id: string }>(async ({ req, ctx, params }) => {
  const body = await parseJson(req, patch);
  if ('sentiment' in body) await correctSentiment(ctx, params.id, { label: body.sentiment });
  else await setExcluded(ctx, params.id, body);
  return getMention(ctx, params.id);
});

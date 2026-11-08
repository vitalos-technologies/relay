// GET /api/assistant/knowledge/candidates?brand_id= → Content Hub documents + saved replies that can be approved.
import { AppError } from '@social-lite/core';
import { knowledgeCandidates } from '@social-lite/services/assistant/index';
import { queryOf, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ req, ctx }) => {
  const b = queryOf(req).brand_id;
  if (!b) throw new AppError('validation_failed', 'Choose a brand', { brand_id: 'Required' });
  return knowledgeCandidates(ctx, b);
});

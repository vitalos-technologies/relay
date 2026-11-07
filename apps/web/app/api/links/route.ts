// V3.1 §14 — GET /api/links?brand_id=&campaign_id= · POST { brand_id, campaign_id?, post_id?, url } — Relay short links.
import { z } from 'zod';
import { AppError } from '@social-lite/core';
import { createTrackedLink, listTrackedLinks } from '@social-lite/services/gov/links';
import { parseJson, route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ req, ctx }) => {
  const brandId = req.nextUrl.searchParams.get('brand_id');
  if (!brandId) throw new AppError('validation_failed', 'brand_id is required', { brand_id: 'Required' });
  return listTrackedLinks(ctx, brandId, { campaign_id: req.nextUrl.searchParams.get('campaign_id') || null });
});
export const POST = route(async ({ req, ctx }) => createTrackedLink(ctx, await parseJson(req, z.unknown())));

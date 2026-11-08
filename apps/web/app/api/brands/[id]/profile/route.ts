// V3.1 §12 — GET/PATCH /api/brands/:id/profile — brand profile (tone, colours, approved logos, CTA default) + active rules.
// PATCH needs brands.manage; never rewrites content: the response lists affected drafts/schedules (impact) for review.
import { z } from 'zod';
import { getBrandProfile, updateBrandProfile } from '@social-lite/services/gov/brand-rules';
import { parseJson, route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route<{ id: string }>(async ({ ctx, params }) => getBrandProfile(ctx, params.id));
export const PATCH = route<{ id: string }>(async ({ req, ctx, params }) => updateBrandProfile(ctx, params.id, await parseJson(req, z.unknown())));

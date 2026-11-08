// V3.1 §14 — GET /api/brands/:id/utm-defaults?campaign_id= · PUT { campaign_id?, params } (brands.manage).
import { z } from 'zod';
import { getUtmDefaults, setUtmDefaults } from '@social-lite/services/gov/links';
import { parseJson, route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route<{ id: string }>(async ({ req, ctx, params }) => getUtmDefaults(ctx, params.id, req.nextUrl.searchParams.get('campaign_id') || null));
export const PUT = route<{ id: string }>(async ({ req, ctx, params }) => setUtmDefaults(ctx, params.id, await parseJson(req, z.unknown())));

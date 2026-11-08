// V3.1 §14 — POST /api/links/preview { brand_id, campaign_id?, url, provider?, overrides? } — validated link with UTM
// params (existing params preserved, no duplicate keys) + origin of each param. Read-only.
import { z } from 'zod';
import { previewCampaignLink } from '@social-lite/services/gov/links';
import { parseJson, route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = route(async ({ req, ctx }) => previewCampaignLink(ctx, await parseJson(req, z.unknown())));

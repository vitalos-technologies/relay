// POST /api/billing/preview { plan, seats } — provider-computed price, timing and proration for a plan/seat change (billing.manage).
import { z } from 'zod';
import { previewChange } from '@social-lite/services/billing/manage';
import { parseJson, route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = route(async ({ req, ctx }) => previewChange(ctx, await parseJson(req, z.unknown())));

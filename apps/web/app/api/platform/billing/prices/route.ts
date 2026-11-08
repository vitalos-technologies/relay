// POST /api/platform/billing/prices { plan_version_id, provider: 'stripe', livemode, price_ref, product_ref?, reason } — map a version to a
// Stripe price (activation step; billing staff, step-up).
import { z } from 'zod';
import { mapProviderPrice } from '@social-lite/services/billing/platform';
import { parseJson, platformRoute } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = platformRoute(async ({ req, p }) => mapProviderPrice(p, await parseJson(req, z.unknown())));

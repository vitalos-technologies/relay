// POST /api/billing/checkout { plan, seats? } — start or reuse the one open hosted checkout (billing.manage). Returns the hosted URL;
// activation only ever comes from verified provider state (webhook / reconciliation), never from the success redirect.
import { z } from 'zod';
import { startCheckout } from '@social-lite/services/billing/manage';
import { parseJson, route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = route(async ({ req, ctx }) => startCheckout(ctx, await parseJson(req, z.unknown())));

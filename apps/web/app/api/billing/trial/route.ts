// POST /api/billing/trial { plan } — start the workspace's one 14-day no-card trial (billing.manage; only if never redeemed).
import { z } from 'zod';
import { startTrial } from '@social-lite/services/billing/manage';
import { parseJson, route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = route(async ({ req, ctx }) => startTrial(ctx, await parseJson(req, z.unknown())));

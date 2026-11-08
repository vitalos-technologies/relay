// POST /api/billing/portal { flow?: 'payment_method_update' | 'subscription_cancel' } — provider-hosted billing portal URL (billing.manage).
import { z } from 'zod';
import { openPortal } from '@social-lite/services/billing/manage';
import { parseJson, route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = route(async ({ req, ctx }) => openPortal(ctx, await parseJson(req, z.unknown())));

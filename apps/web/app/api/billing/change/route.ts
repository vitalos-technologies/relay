// POST /api/billing/change { plan, seats, proration_date, expected_version } (Idempotency-Key) — apply an upgrade / seat increase now
// or schedule a downgrade / seat reduction for period end (billing.manage). DELETE — undo the scheduled change.
import { z } from 'zod';
import { applyChange, cancelScheduledChange } from '@social-lite/services/billing/manage';
import { idempotencyKey, parseJson, route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = route(async ({ req, ctx }) => applyChange(ctx, await parseJson(req, z.unknown()), idempotencyKey(req)));
export const DELETE = route(async ({ ctx }) => cancelScheduledChange(ctx));

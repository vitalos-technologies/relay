// Test mode only (deterministic billing test double; refused when Stripe or production is configured).
// GET /api/billing/test/checkout?session=cs_test_… — summary of a test hosted checkout owned by the active workspace.
// POST { session, outcome: 'paid' | 'declined' | 'requires_action' | 'cancel' } — simulate the customer at the hosted page. The
// result reaches Relay only as signed provider events through the webhook verification path. Needs billing.manage.
import { z } from 'zod';
import { testCheckoutAction, testCheckoutSummary } from '@social-lite/services/billing/test-pages';
import { parseJson, route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ req, ctx }) => testCheckoutSummary(ctx, req.nextUrl.searchParams.get('session') ?? ''));
export const POST = route(async ({ req, ctx }) => testCheckoutAction(ctx, await parseJson(req, z.unknown())));

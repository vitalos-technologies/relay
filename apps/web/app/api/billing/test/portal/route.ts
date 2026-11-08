// Test mode only. GET /api/billing/test/portal?session=bps_test_… — the test customer portal for the active workspace.
// POST { session, action } — update card, cancel/resume renewal, and simulate renewal / failed payment / recovery (signed events).
import { z } from 'zod';
import { testPortalAction, testPortalSummary } from '@social-lite/services/billing/test-pages';
import { parseJson, route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ req, ctx }) => testPortalSummary(ctx, req.nextUrl.searchParams.get('session') ?? ''));
export const POST = route(async ({ req, ctx }) => testPortalAction(ctx, await parseJson(req, z.unknown())));

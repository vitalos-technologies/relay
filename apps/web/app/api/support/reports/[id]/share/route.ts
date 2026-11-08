// V4 Relay support — GET /api/support/reports/:id/share: what would be shared (review); POST { diagnostics[], include_draft_excerpt?,
// category?, subject?, message?, ticket_id? } (Idempotency-Key): explicitly send this problem report to Relay support.
import { z } from 'zod';
import { previewReportShare, shareReportToSupport } from '@social-lite/services/support/reports';
import { idempotencyKey, parseJson, route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route<{ id: string }>(async ({ ctx, params }) => previewReportShare(ctx, params.id));
export const POST = route<{ id: string }>(async ({ req, ctx, params }) => shareReportToSupport(ctx, params.id, await parseJson(req, z.unknown()), idempotencyKey(req)));

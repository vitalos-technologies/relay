// V3.1 §16 — POST /api/support/reports { category, summary, route?, app_version?, occurred_at?, correlation_ids?,
// include_draft_post_id? } — redacted problem report. GET (audit.read) lists the workspace's reports.
import { z } from 'zod';
import { createSupportReport, listSupportReports } from '@social-lite/services/gov/release';
import { parseJson, route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ ctx }) => listSupportReports(ctx));
export const POST = route(async ({ req, ctx }) => createSupportReport(ctx, await parseJson(req, z.unknown())));

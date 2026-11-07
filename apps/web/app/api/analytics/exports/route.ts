// GET /api/analytics/exports — my recent exports. POST {view, format: csv|pdf|html, destination?, destination_ref?, report_id? | query_string?}
// ⇒ 202-style queued export (rendered by the worker; poll GET /api/analytics/exports/:id).
import { listReportExports, requestReportExport } from '@social-lite/services/analytics/reports';
import { parseJson, route } from '@/lib/api';
import { z } from 'zod';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ ctx }) => ({ items: await listReportExports(ctx) }));
export const POST = route(async ({ req, ctx }) => requestReportExport(ctx, await parseJson(req, z.unknown())));

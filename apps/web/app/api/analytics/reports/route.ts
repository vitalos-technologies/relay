// GET /api/analytics/reports — saved views the caller can open. POST {name, view, query_string|filters, visibility}.
import { createReport, listReports } from '@social-lite/services/analytics/reports';
import { parseJson, route } from '@/lib/api';
import { z } from 'zod';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ ctx }) => ({ items: await listReports(ctx) }));
export const POST = route(async ({ req, ctx }) => createReport(ctx, await parseJson(req, z.unknown())));

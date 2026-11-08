// GET /api/analytics/reports/:id — open a saved view (access re-checked now) → { report, data }. PATCH/DELETE: owner only.
import { deleteReport, openReport, updateReport } from '@social-lite/services/analytics/reports';
import { parseJson, route } from '@/lib/api';
import { z } from 'zod';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route<{ reportId: string }>(async ({ ctx, params }) => openReport(ctx, params.reportId));
export const PATCH = route<{ reportId: string }>(async ({ req, ctx, params }) => updateReport(ctx, params.reportId, await parseJson(req, z.unknown())));
export const DELETE = route<{ reportId: string }>(async ({ ctx, params }) => deleteReport(ctx, params.reportId));

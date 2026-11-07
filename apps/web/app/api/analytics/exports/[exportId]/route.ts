// GET /api/analytics/exports/:id — export status, manifest and download path (requester only).
import { getReportExport } from '@social-lite/services/analytics/reports';
import { route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route<{ exportId: string }>(async ({ ctx, params }) => getReportExport(ctx, params.exportId));

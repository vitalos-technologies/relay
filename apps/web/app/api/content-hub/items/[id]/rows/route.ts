// GET /api/content-hub/items/:id/rows?cursor — mapped row preview with row-level errors.
import * as ch from '@social-lite/services/content-hub/index';
import { route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route<{ id: string }>(async ({ req, ctx, params }) => ch.previewRows(ctx, params.id, { cursor: req.nextUrl.searchParams.get('cursor') }));

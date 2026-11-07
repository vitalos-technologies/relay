// GET /api/content-hub/items/:id/schema — Notion data source properties + saved mapping.
import * as ch from '@social-lite/services/content-hub/index';
import { route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route<{ id: string }>(async ({ ctx, params }) => ch.getDataSourceSchema(ctx, params.id));

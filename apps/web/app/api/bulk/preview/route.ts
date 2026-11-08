// POST /api/bulk/preview — affected items + permission/policy consequences + preview_hash. Read-only.
import { previewBulk } from '@social-lite/services/data/bulk';
import type { BulkRequest } from '@social-lite/core/contracts/v31-data';
import { parseJson, route } from '@/lib/api';
import { bulkRequest } from '../schema';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = route(async ({ req, ctx }) => previewBulk(ctx, (await parseJson(req, bulkRequest)) as BulkRequest));

// GET /api/content-hub/items/:id (item + snapshot history) · DELETE (delete snapshots + link; refused while on hold)
import * as ch from '@social-lite/services/content-hub/index';
import { route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route<{ id: string }>(async ({ ctx, params }) => ch.getSourceItem(ctx, params.id));
export const DELETE = route<{ id: string }>(async ({ ctx, params }) => ch.deleteSourceItem(ctx, params.id));

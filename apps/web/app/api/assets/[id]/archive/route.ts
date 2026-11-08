// POST /api/assets/:id/archive — 409 while referenced by an active schedule/delivery (ME-05).
import { archiveAsset } from '@social-lite/services/media/assets';
import { route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = route<{ id: string }>(async ({ ctx, params }) => archiveAsset(ctx, params.id));

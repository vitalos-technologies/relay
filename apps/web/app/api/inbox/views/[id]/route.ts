// DELETE /api/inbox/views/:id
import { deleteSavedView } from '@social-lite/services/inbox/index';
import { route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const DELETE = route<{ id: string }>(async ({ ctx, params }) => { await deleteSavedView(ctx, params.id); return { ok: true }; });

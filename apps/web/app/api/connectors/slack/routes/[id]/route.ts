// DELETE /api/connectors/slack/routes/:id
import { deleteSlackRoute } from '@social-lite/services/integrations-v35/index';
import { route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const DELETE = route<{ id: string }>(async ({ ctx, params }) => { await deleteSlackRoute(ctx, params.id); return { ok: true }; });

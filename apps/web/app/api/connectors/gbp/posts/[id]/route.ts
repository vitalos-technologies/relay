// DELETE /api/connectors/gbp/posts/:id — cancel a not-yet-sent Google post
import { cancelGbpLocalPost } from '@social-lite/services/integrations-v35/index';
import { route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const DELETE = route<{ id: string }>(async ({ ctx, params }) => { await cancelGbpLocalPost(ctx, params.id); return { ok: true }; });

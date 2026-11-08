// POST /api/inbox/conversations/:id/customer/unlink { reason } — reversible: history is kept.
import { unlinkIdentity, unlinkSchema } from '@social-lite/services/inbox/index';
import { parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = route<{ id: string }>(async ({ req, ctx, params }) => unlinkIdentity(ctx, params.id, await parseJson(req, unlinkSchema)));

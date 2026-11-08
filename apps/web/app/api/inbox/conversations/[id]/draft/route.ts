// PUT /api/inbox/conversations/:id/draft { mode, body, base_version } — server copy of the unsent reply (empty body deletes it).
import { draftSchema, saveDraft } from '@social-lite/services/inbox/index';
import { parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const PUT = route<{ id: string }>(async ({ req, ctx, params }) => saveDraft(ctx, params.id, await parseJson(req, draftSchema)));

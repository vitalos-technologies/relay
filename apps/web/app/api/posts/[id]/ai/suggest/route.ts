// POST /api/posts/:id/ai/suggest {task, connection_ids?, tone?, source_url?, source_post_id?}
// → {suggestions:[{scope, before, text, hashtags, note, issues, rejected}], usage, fixture, model, post_version, notices}
// Suggestions only: the draft is never modified here. The composer applies an accepted suggestion
// through PATCH /api/posts/:id with expected_version. Permission: drafts.edit on the post's brand.
import { suggestForPost, suggestRequestSchema } from '@social-lite/services/ai/index';
import { parseJson, route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

export const POST = route<{ id: string }>(async ({ req, ctx, params }) => suggestForPost(ctx, params.id, await parseJson(req, suggestRequestSchema)));

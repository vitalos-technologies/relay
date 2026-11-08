// POST /api/posts/:id/readiness { mode, connection_ids, input_local_time?, timezone?, offset?, deadline_minutes? }
// Read-only publishing preflight: every reason (permission, tokens, media, approval, deadline, provider
// limits, budget, duplicates) with its fix. POST only because it carries a body; nothing is written.
import { z } from 'zod';
import { readiness } from '@social-lite/services/product/readiness';
import { parseJson, route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = route<{ id: string }>(async ({ req, ctx, params }) => readiness(ctx, params.id, await parseJson(req, z.unknown())));

// POST /api/workspace/pause { paused, reason? } (owner/admin/approver) — emergency pause (SC-05).
import { z } from 'zod';
import { setWorkspacePaused } from '@social-lite/services/workspaces';
import { parseJson, route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const body = z.object({ paused: z.boolean(), reason: z.string().max(500).nullish() }).strict();

export const POST = route(async ({ req, ctx }) => setWorkspacePaused(ctx, await parseJson(req, body)));

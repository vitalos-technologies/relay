// GET /api/workspace, PATCH /api/workspace { name?, timezone? } (owner/admin).
import { z } from 'zod';
import { getWorkspace, updateWorkspace } from '@social-lite/services/workspaces';
import { parseJson, route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const patch = z.object({ name: z.string().max(200).optional(), timezone: z.string().max(64).optional() }).strict();

export const GET = route(async ({ ctx }) => getWorkspace(ctx));
export const PATCH = route(async ({ req, ctx }) => updateWorkspace(ctx, await parseJson(req, patch)));

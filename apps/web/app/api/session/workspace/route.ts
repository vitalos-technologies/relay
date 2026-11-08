// POST /api/session/workspace { workspace_id } — switch the active workspace.
import { z } from 'zod';
import { switchWorkspace } from '@social-lite/services/workspaces';
import { parseJson, route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const body = z.object({ workspace_id: z.string().min(1).max(64) });

export const POST = route(async ({ req, session, ctx }) => {
  const { workspace_id } = await parseJson(req, body);
  return switchWorkspace(session, ctx.actor, workspace_id);
}, { workspace: false });

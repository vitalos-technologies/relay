// POST /api/platform/workspaces/:id/suspend { reason } — operator, fresh sign-in.
import { z } from 'zod';
import { suspendWorkspace } from '@social-lite/services/admin/platform';
import { parseJson, platformRoute } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = platformRoute<{ id: string }>(async ({ req, p, params }) => suspendWorkspace(p, params.id, await parseJson(req, z.unknown())));

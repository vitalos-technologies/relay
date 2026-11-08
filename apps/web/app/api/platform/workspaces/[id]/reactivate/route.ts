// POST /api/platform/workspaces/:id/reactivate { reason } — operator, fresh sign-in.
import { z } from 'zod';
import { reactivateWorkspace } from '@social-lite/services/admin/platform';
import { parseJson, platformRoute } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = platformRoute<{ id: string }>(async ({ req, p, params }) => reactivateWorkspace(p, params.id, await parseJson(req, z.unknown())));

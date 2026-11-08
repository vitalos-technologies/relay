// POST /api/platform/workspaces/:id/dispatch-concurrency { dispatch_concurrency|null, reason } — operator, fresh.
import { z } from 'zod';
import { setDispatchConcurrency } from '@social-lite/services/admin/platform';
import { parseJson, platformRoute } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = platformRoute<{ id: string }>(async ({ req, p, params }) => setDispatchConcurrency(p, params.id, await parseJson(req, z.unknown())));

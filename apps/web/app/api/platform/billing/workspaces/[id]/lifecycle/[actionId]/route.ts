// POST /api/platform/billing/workspaces/:id/lifecycle/:actionId { reason } — cancel a scheduled lifecycle action (operator, step-up).
import { z } from 'zod';
import { cancelLifecycleAction } from '@social-lite/services/billing/platform';
import { parseJson, platformRoute } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = platformRoute<{ id: string; actionId: string }>(async ({ req, p, params }) => cancelLifecycleAction(p, params.id, params.actionId, await parseJson(req, z.unknown())));

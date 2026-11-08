// POST /api/platform/billing/workspaces/:id/lifecycle { action: 'suspend', run_at, reason } — schedule a SERVICE suspension (operator, step-up).
import { z } from 'zod';
import { scheduleLifecycleAction } from '@social-lite/services/billing/platform';
import { parseJson, platformRoute } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = platformRoute<{ id: string }>(async ({ req, p, params }) => scheduleLifecycleAction(p, params.id, await parseJson(req, z.unknown())));

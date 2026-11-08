// GET /api/automation/emergency-stop · POST {active} — workspace-wide stop; cancels queued automated replies.
import { z } from 'zod';
import { emergencyStopState, setEmergencyStop } from '@social-lite/services/automation/index';
import { requireAction } from '@social-lite/services';
import { parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ ctx }) => { requireAction(ctx, 'automation.manage'); return emergencyStopState(ctx.access.workspaceId); });
export const POST = route(async ({ req, ctx }) => setEmergencyStop(ctx, (await parseJson(req, z.object({ active: z.boolean() }).strict())).active));

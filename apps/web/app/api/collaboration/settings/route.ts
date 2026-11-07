// GET /api/collaboration/settings · PUT (workspace.manage) — workspace collaboration settings.
import { z } from 'zod';
import { getCollabSettings, updateCollabSettings } from '@social-lite/services';
import { parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ch = z.object({ in_app: z.boolean().optional(), email: z.boolean().optional(), digest: z.boolean().optional() }).strict();
const body = z.object({
  client_comments: z.boolean().optional(), task_assign: z.enum(['contributors', 'managers']).optional(), offboarding: z.enum(['flag', 'unassign']).optional(),
  reminder_lead_hours: z.number().int().min(1).max(168).optional(), max_overdue_reminders: z.number().int().min(0).max(10).optional(),
  presence_enabled: z.boolean().optional(), notification_defaults: z.record(z.string(), ch).optional(),
}).strict();
export const GET = route(async ({ ctx }) => getCollabSettings(ctx));
export const PUT = route(async ({ req, ctx }) => updateCollabSettings(ctx, await parseJson(req, body) as Parameters<typeof updateCollabSettings>[1]));

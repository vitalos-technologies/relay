// GET/PUT /api/notification-preferences — per event type in-app/email/digest, quiet hours, digest hour.
import { z } from 'zod';
import { getNotificationPreferences, updateNotificationPreferences } from '@social-lite/services';
import { parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const body = z.object({
  events: z.array(z.object({ event_type: z.string().max(40), in_app: z.boolean().optional(), email: z.boolean().optional(), digest: z.boolean().optional() }).strict()).max(20).optional(),
  timezone: z.string().max(64).optional(),
  quiet_start: z.number().int().min(0).max(1439).nullable().optional(),
  quiet_end: z.number().int().min(0).max(1439).nullable().optional(),
  digest_hour: z.number().int().min(0).max(23).optional(),
}).strict();
export const GET = route(async ({ ctx }) => getNotificationPreferences(ctx));
export const PUT = route(async ({ req, ctx }) => updateNotificationPreferences(ctx, await parseJson(req, body)));

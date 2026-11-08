// POST /api/connectors/slack/link { token } — the signed-in Relay user confirms the Slack identity that clicked (single use, 10 min)
import { z } from 'zod';
import { confirmSlackLink } from '@social-lite/services/integrations-v35/index';
import { parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const body = z.object({ token: z.string().min(10).max(100) }).strict();
export const POST = route(async ({ req, ctx }) => confirmSlackLink(ctx, (await parseJson(req, body)).token));

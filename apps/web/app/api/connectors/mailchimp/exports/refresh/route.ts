// POST /api/connectors/mailchimp/exports/refresh { post_id } — campaign status + report (explicit; stored)
import { z } from 'zod';
import { refreshMailchimpCampaign } from '@social-lite/services/integrations-v35/index';
import { parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const body = z.object({ post_id: z.string().uuid() }).strict();
export const POST = route(async ({ req, ctx }) => refreshMailchimpCampaign(ctx, (await parseJson(req, body)).post_id));

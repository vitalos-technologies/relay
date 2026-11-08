// GET /api/connectors/mailchimp/exports?post_id= · POST — draft campaign from approved content (never sends, never subscribes)
import { exportSchema, exportToMailchimp, mailchimpExportsForPost } from '@social-lite/services/integrations-v35/index';
import { parseJson, queryOf, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ req, ctx }) => mailchimpExportsForPost(ctx, queryOf(req).post_id ?? ''));
export const POST = route(async ({ req, ctx }) => exportToMailchimp(ctx, await parseJson(req, exportSchema)));

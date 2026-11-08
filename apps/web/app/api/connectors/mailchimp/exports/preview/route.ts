// POST /api/connectors/mailchimp/exports/preview — exact content + audience before export
import { exportSchema, previewMailchimpExport } from '@social-lite/services/integrations-v35/index';
import { parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = route(async ({ req, ctx }) => previewMailchimpExport(ctx, await parseJson(req, exportSchema)));

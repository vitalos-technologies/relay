// POST /api/connectors/mailchimp/campaign-links { integration_id, campaign_id, mailchimp_campaign_id } — link social ↔ email campaign
import { linkCampaignSchema, linkMailchimpCampaign } from '@social-lite/services/integrations-v35/index';
import { parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = route(async ({ req, ctx }) => linkMailchimpCampaign(ctx, await parseJson(req, linkCampaignSchema)));

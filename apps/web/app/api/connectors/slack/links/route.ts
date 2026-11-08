// GET /api/connectors/slack/links?integration_id= — Slack ↔ Relay identity links (explicit only)
import { listSlackLinks } from '@social-lite/services/integrations-v35/index';
import { queryOf, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ req, ctx }) => listSlackLinks(ctx, queryOf(req).integration_id ?? ''));

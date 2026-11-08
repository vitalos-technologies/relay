// V5 WID — GET /api/widget/session: who the widget talks as (member / visitor), availability ("Send us a message" unless
// staffed chat is configured), CSRF tokens for this browser's identities, a signed form token, and recent conversations.
import { widgetSessionInfo } from '@social-lite/services/support/widget';
import { widgetRoute } from '../_lib';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = widgetRoute(async ({ caller }) => ({ body: await widgetSessionInfo(caller) }));

// POST /api/webhooks/google-drive — Drive push notifications (empty body; channel id + token headers). Signal only.
import { handleDriveNotification } from '@social-lite/services/content-hub/index';
import { publicRoute } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = publicRoute(async ({ req }) => {
  const h = req.headers;
  const r = await handleDriveNotification({ channelId: h.get('x-goog-channel-id'), token: h.get('x-goog-channel-token'), resourceState: h.get('x-goog-resource-state'),
    messageNumber: h.get('x-goog-message-number'), resourceId: h.get('x-goog-resource-id') });
  // Unknown channels/bad tokens are refused; Google treats non-2xx as failure.
  return new Response(null, { status: r === 'bad_token' || r === 'unknown_channel' ? 401 : 200 });
});

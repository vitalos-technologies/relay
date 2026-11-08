// V5 WID — POST /api/widget/conversations: start a conversation (a V4 support ticket, source 'widget').
// Member: { client_id, workspace_id?, message, topic?, attachment_ids? } — workspace validated on the server.
// Visitor: { client_id, name, email, message, topic?, attachment_ids?, form_token, website (honeypot), diagnostics? }.
// client_id deduplicates retries; a first visitor message creates the visitor session (cookie).
import { createConversation } from '@social-lite/services/support/widget';
import { widgetJson, widgetRoute } from '../_lib';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = widgetRoute(async ({ req, caller }) => {
  const r = await createConversation(caller, await widgetJson(req));
  return { body: r.conversation, status: 201, setSession: r.newSession };
});

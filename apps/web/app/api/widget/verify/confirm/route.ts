// V5 WID — POST /api/widget/verify/confirm { code } | { token }: prove control of the email; this browser session may then
// see conversations started with it. Never links a user account or workspace.
import { confirmVerification } from '@social-lite/services/support/widget-verify';
import { widgetJson, widgetRoute } from '../../_lib';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = widgetRoute(async ({ req, caller }) => {
  const r = await confirmVerification(caller, await widgetJson(req));
  return { body: { verified_email: r.verified_email, conversations: r.conversations, open_reference: r.open_reference }, setSession: r.newSession };
});

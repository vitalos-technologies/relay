// V5 WID — POST /api/widget/verify { email }: email a one-time code + link IF that address has widget conversations.
// Always answers 202 the same way (no enumeration); rate-limited per IP and per address.
import { requestVerification } from '@social-lite/services/support/widget-verify';
import { widgetJson, widgetRoute } from '../_lib';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = widgetRoute(async ({ req, caller }) => {
  const r = await requestVerification(caller, await widgetJson(req));
  return { body: { ok: true, expires_in_minutes: r.expires_in_minutes }, status: 202, setSession: r.newSession };
});

// V5 WID — POST /api/widget/session/end: "End chat on this device" (revokes the visitor session; clears the cookie).
// Conversations are kept; reopening them on this device needs the emailed one-time code.
import { getPool } from '@social-lite/db';
import { revokeWidgetSession } from '@social-lite/services/support/widget-session';
import { widgetRoute } from '../../_lib';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = widgetRoute(async ({ caller }) => {
  if (caller.visitor) await revokeWidgetSession(getPool(), caller.visitor.id);
  return { body: { ok: true }, clearSession: true };
});

// V5 WID — GET /api/widget/conversations/:ref?after=<cursor>: one conversation the caller may see (visitor identity /
// verified email, or the member's V4 visibility). after=0 → full history; after>0 → only what was published since the
// cursor (missed-message recovery after a reconnect). Public messages only — internal notes never leave the server.
import { getConversation } from '@social-lite/services/support/widget';
import { widgetRoute } from '../../_lib';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = widgetRoute<{ ref: string }>(async ({ req, params, caller }) => {
  const after = Number(req.nextUrl.searchParams.get('after') ?? '0');
  return { body: await getConversation(caller, params.ref, Number.isSafeInteger(after) && after > 0 ? after : 0) };
});

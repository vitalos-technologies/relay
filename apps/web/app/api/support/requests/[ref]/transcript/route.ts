// V4 Relay support — GET /api/support/requests/:ref/transcript: plain-text export of the public conversation.
import { ticketTranscript } from '@social-lite/services/support/tickets';
import { route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route<{ ref: string }>(async ({ ctx, params }) => {
  const t = await ticketTranscript(ctx, params.ref);
  return new Response(t.text, { headers: { 'content-type': 'text/plain; charset=utf-8', 'content-disposition': `attachment; filename="${t.filename}"`, 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' } });
});

// V4 Relay support — GET /api/support/requests/:ref/events?after=<id>: content-free change feed (customer audience only);
// the client refetches the request through the authorized API when something changed.
import { customerTicketEvents } from '@social-lite/services/support/tickets';
import { route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route<{ ref: string }>(async ({ req, ctx, params }) => customerTicketEvents(ctx, params.ref, Number(req.nextUrl.searchParams.get('after') ?? 0)));

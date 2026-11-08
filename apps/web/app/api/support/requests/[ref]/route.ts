// V4 Relay support — GET /api/support/requests/:ref (RLY-… or id): one request the caller may see (public messages only; marks it read).
import { getTicket } from '@social-lite/services/support/tickets';
import { route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route<{ ref: string }>(async ({ ctx, params }) => getTicket(ctx, params.ref));

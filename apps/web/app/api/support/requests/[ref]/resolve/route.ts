// V4 Relay support — POST /api/support/requests/:ref/resolve: the customer marks the request resolved.
import { resolveTicket } from '@social-lite/services/support/tickets';
import { route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = route<{ ref: string }>(async ({ ctx, params }) => resolveTicket(ctx, params.ref));

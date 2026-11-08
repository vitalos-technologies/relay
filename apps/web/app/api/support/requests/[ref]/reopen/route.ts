// V4 Relay support — POST /api/support/requests/:ref/reopen: reopen a resolved request (inside the reopen window).
import { reopenTicket } from '@social-lite/services/support/tickets';
import { route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = route<{ ref: string }>(async ({ ctx, params }) => reopenTicket(ctx, params.ref));

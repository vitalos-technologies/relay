// V4 Relay support — DELETE /api/support/requests/:ref/participants/:userId: remove a participant (or leave).
import { removeParticipant } from '@social-lite/services/support/tickets';
import { route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const DELETE = route<{ ref: string; userId: string }>(async ({ ctx, params }) => removeParticipant(ctx, params.ref, params.userId));

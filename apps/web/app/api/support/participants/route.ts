// V4 Relay support — GET /api/support/participants: members the caller may add to a request (needs members.read).
import { participantCandidates } from '@social-lite/services/support/tickets';
import { route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ ctx }) => participantCandidates(ctx));

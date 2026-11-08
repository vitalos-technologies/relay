// GET /api/inbox/conversations/:id/customer — provider identity, linked customer, other identities + conversations the
// viewer may read, and the link history. Stream B.
import { customerProfile } from '@social-lite/services/inbox/index';
import { route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route<{ id: string }>(async ({ ctx, params }) => customerProfile(ctx, params.id));

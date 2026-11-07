// GET /api/publication-holds — adoption queue: queued publications held because their scheduling
// authority (or a required approver) lost rights. can_adopt per item for the caller.
import { listHeldPublications } from '@social-lite/services/engine/authority';
import { route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ ctx }) => listHeldPublications(ctx));

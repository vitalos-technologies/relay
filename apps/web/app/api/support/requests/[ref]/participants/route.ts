// V4 Relay support — POST /api/support/requests/:ref/participants { user_id }: add a member of this workspace.
import { z } from 'zod';
import { addParticipant } from '@social-lite/services/support/tickets';
import { parseJson, route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = route<{ ref: string }>(async ({ req, ctx, params }) => addParticipant(ctx, params.ref, await parseJson(req, z.unknown())));

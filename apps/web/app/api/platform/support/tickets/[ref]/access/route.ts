// V4 Platform → Support — POST /api/platform/support/tickets/:ref/access { reason, duration_minutes }: request owner-approved,
// time-boxed, read-only support access for the ticket's workspace (existing flow; owners are notified).
import { z } from 'zod';
import { requestAccessForTicket } from '@social-lite/services/support/staff';
import { parseJson, platformRoute } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = platformRoute<{ ref: string }>(async ({ req, p, params }) => requestAccessForTicket(p, params.ref, await parseJson(req, z.unknown())));

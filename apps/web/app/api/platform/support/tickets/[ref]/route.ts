// V4 Platform → Support — GET /api/platform/support/tickets/:ref (timeline with notes, workspace context); PATCH { priority?, category?, status?, resolution_reason? }.
import { z } from 'zod';
import { getStaffTicket, updateTicket } from '@social-lite/services/support/staff';
import { parseJson, platformRoute } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = platformRoute<{ ref: string }>(async ({ p, params }) => getStaffTicket(p, params.ref));
export const PATCH = platformRoute<{ ref: string }>(async ({ req, p, params }) => updateTicket(p, params.ref, await parseJson(req, z.unknown())));

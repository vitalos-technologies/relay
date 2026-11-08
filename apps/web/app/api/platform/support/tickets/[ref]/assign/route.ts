// V4 Platform → Support — POST /api/platform/support/tickets/:ref/assign { assignee_id | null }.
import { z } from 'zod';
import { assignTicket } from '@social-lite/services/support/staff';
import { parseJson, platformRoute } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = platformRoute<{ ref: string }>(async ({ req, p, params }) => assignTicket(p, params.ref, await parseJson(req, z.unknown())));

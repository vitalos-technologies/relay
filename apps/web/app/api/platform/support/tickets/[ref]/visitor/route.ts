// V5 WID — POST /api/platform/support/tickets/:ref/visitor { blocked }: block / unblock the widget visitor behind a ticket
// (support staff; audited; blocking ends the visitor's sessions).
import { z } from 'zod';
import { setVisitorBlocked } from '@social-lite/services/support/widget';
import { parseJson, platformRoute } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = platformRoute<{ ref: string }>(async ({ req, params, p }) => setVisitorBlocked(p, params.ref, await parseJson(req, z.unknown())));

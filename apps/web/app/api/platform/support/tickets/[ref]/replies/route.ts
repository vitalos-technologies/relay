// V4 Platform → Support — POST /api/platform/support/tickets/:ref/replies { body, attachment_ids?, resolve? } (Idempotency-Key): PUBLIC reply to the customer.
import { z } from 'zod';
import { staffReply } from '@social-lite/services/support/staff';
import { idempotencyKey, parseJson, platformRoute } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = platformRoute<{ ref: string }>(async ({ req, p, params }) => staffReply(p, params.ref, await parseJson(req, z.unknown()), idempotencyKey(req)));

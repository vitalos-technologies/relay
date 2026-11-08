// V4 Platform → Support — POST /api/platform/support/tickets/:ref/notes { body, attachment_ids? } (Idempotency-Key): staff-only internal note.
import { z } from 'zod';
import { staffNote } from '@social-lite/services/support/staff';
import { idempotencyKey, parseJson, platformRoute } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = platformRoute<{ ref: string }>(async ({ req, p, params }) => staffNote(p, params.ref, await parseJson(req, z.unknown()), idempotencyKey(req)));

// V4 Platform → Support — POST /api/platform/support/tickets/:ref/duplicate { of: "RLY-…" }: link as duplicate and resolve.
import { z } from 'zod';
import { markDuplicate } from '@social-lite/services/support/staff';
import { parseJson, platformRoute } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = platformRoute<{ ref: string }>(async ({ req, p, params }) => markDuplicate(p, params.ref, await parseJson(req, z.unknown())));

// POST /api/content-hub/writebacks/:id/resolve { decision: overwrite | keep_external }
import { z } from 'zod';
import * as ch from '@social-lite/services/content-hub/index';
import { parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const body = z.object({ decision: z.enum(['overwrite', 'keep_external']) }).strict();
export const POST = route<{ id: string }>(async ({ req, ctx, params }) => ch.resolveWritebackConflict(ctx, params.id, (await parseJson(req, body)).decision));

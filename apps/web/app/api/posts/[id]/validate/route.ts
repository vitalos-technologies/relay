import { z } from 'zod';
import { validatePost } from '@social-lite/services';
import { parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const body = z.object({ connection_ids: z.array(z.string().uuid()).max(50).optional() });
export const POST = route<{ id: string }>(async ({ req, ctx, params }) => validatePost(ctx, params.id, (await parseJson(req, body)).connection_ids));

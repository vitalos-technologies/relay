// POST CSV preview (validation per row and destination). Creates nothing.
import { z } from 'zod';
import { previewImport } from '@social-lite/services/imports';
import { parseJson, route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = route<{ id: string }>(async ({ req, ctx, params }) => previewImport(ctx, params.id, (await parseJson(req, z.object({ csv: z.string().min(1) }))).csv));

// POST commit a previewed CSV: creates DRAFTS for valid rows only. Never schedules or publishes.
import { z } from 'zod';
import { commitImport } from '@social-lite/services/imports';
import { idempotencyKey, parseJson, route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const body = z.object({ csv: z.string().min(1), csv_hash: z.string().length(64) });
export const POST = route<{ id: string }>(async ({ req, ctx, params }) => {
  const b = await parseJson(req, body);
  return Response.json(await commitImport(ctx, params.id, b.csv, b.csv_hash, idempotencyKey(req)), { status: 201 });
});

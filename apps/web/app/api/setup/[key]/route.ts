// PUT /api/setup/:key { value } (owner) — store a provider/AI/TipSignal setting (secrets encrypted, write-only).
// An empty value clears a setting entered here. Env-provided settings are read-only (409).
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { putSetup } from '@social-lite/services/setup';
import { parseJson, route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const body = z.object({ value: z.string().max(4096) }).strict();

export const PUT = route<{ key: string }>(async ({ req, ctx, params }) => {
  const { value } = await parseJson(req, body);
  return NextResponse.json(await putSetup(ctx, params.key, value), { headers: { 'cache-control': 'no-store' } });
});

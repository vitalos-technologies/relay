// POST /api/workspaces { name, timezone, brand_name? } — first-run workspace creation
// (workspace + owner membership + first brand). Works without an active workspace.
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createWorkspace } from '@social-lite/services/workspaces';
import { parseJson, route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const body = z.object({ name: z.string().max(200), timezone: z.string().max(64), brand_name: z.string().max(200).optional() }).strict();

export const POST = route(async ({ req, session, ctx, correlationId }) => {
  const input = await parseJson(req, body);
  return NextResponse.json(await createWorkspace(session, ctx.actor, input, correlationId), { status: 201 });
}, { workspace: false });

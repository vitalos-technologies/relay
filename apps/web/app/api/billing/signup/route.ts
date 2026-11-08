// GET /api/billing/signup — signup handoff context. POST { name, timezone, plan, brand_name? } — create the workspace and start
// its 14-day no-card trial on the selected plan (same transaction). Works without an active workspace.
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { signupContext, signupWorkspace } from '@social-lite/services/billing/signup';
import { parseJson, route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ ctx }) => signupContext(ctx.actor), { workspace: false });
export const POST = route(async ({ req, session, ctx, correlationId }) => NextResponse.json(await signupWorkspace(session, ctx.actor, await parseJson(req, z.unknown()), correlationId), { status: 201 }), { workspace: false });

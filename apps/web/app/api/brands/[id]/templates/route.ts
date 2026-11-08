// GET /api/brands/:id/templates · POST /api/brands/:id/templates { name, body, tags? }
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createTemplate, listTemplates } from '@social-lite/services/templates';
import { parseJson, route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const body = z.object({ name: z.string().max(200), body: z.string().max(10_000), tags: z.array(z.string().max(100)).max(50).optional() }).strict();

export const GET = route<{ id: string }>(async ({ ctx, params }) => ({ items: await listTemplates(ctx, params.id) }));
export const POST = route<{ id: string }>(async ({ req, ctx, params }) =>
  NextResponse.json(await createTemplate(ctx, params.id, await parseJson(req, body)), { status: 201 }));

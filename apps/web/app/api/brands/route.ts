// GET /api/brands · POST /api/brands { name, timezone? } (owner/admin)
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createBrand, listBrands } from '@social-lite/services/brands';
import { parseJson, route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const body = z.object({ name: z.string().max(200), timezone: z.string().max(64).optional() }).strict();

export const GET = route(async ({ ctx }) => ({ items: await listBrands(ctx) }));
export const POST = route(async ({ req, ctx }) => NextResponse.json(await createBrand(ctx, await parseJson(req, body)), { status: 201 }));

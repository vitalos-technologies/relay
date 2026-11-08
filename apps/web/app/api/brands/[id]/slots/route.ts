// GET /api/brands/:id/slots (any member with brand access) · POST (owner/admin) { label?, weekdays[1-7], local_time HH:MM, timezone?, connection_ids }
import { createSlot, listSlots } from '@social-lite/services/slots/index';
import { parseJson, route } from '@/lib/api';
import { z } from 'zod';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route<{ id: string }>(async ({ req, ctx, params }) =>
  listSlots(ctx, params.id, { preview: Number(req.nextUrl.searchParams.get('preview') ?? 5) || 5 }));
export const POST = route<{ id: string }>(async ({ req, ctx, params }) => createSlot(ctx, params.id, await parseJson(req, z.unknown())));

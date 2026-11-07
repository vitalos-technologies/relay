// V3.1 §13 — POST /api/brands/:id/content-queue/next 🔁 (Idempotency-Key) — schedule the first eligible item into the
// next free slot occurrence through the normal pipeline. One item per call; never recurring.
import { NextResponse } from 'next/server';
import { scheduleNextFromQueue } from '@social-lite/services/gov/reuse';
import { idempotencyKey, route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = route<{ id: string }>(async ({ req, ctx, params }) => NextResponse.json(await scheduleNextFromQueue(ctx, params.id, idempotencyKey(req)), { status: 202 }));

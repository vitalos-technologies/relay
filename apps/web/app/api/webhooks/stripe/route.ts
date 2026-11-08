// POST /api/webhooks/stripe — billing provider webhooks. Raw body + Stripe-Signature (v1 HMAC, 5 min tolerance, rotation) are
// verified before anything is stored; duplicates are acknowledged without re-processing; processing re-fetches provider state.
// Bad signature → 400 (nothing stored). Billing not configured → 503 (the provider retries later).
import { NextResponse, type NextRequest } from 'next/server';
import { AppError } from '@social-lite/core';
import { ingestWebhook } from '@social-lite/services/billing/webhooks';
import { publicRoute } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const MAX_BYTES = 1024 * 1024;

export const POST = publicRoute(async ({ req }: { req: NextRequest }) => {
  if (Number(req.headers.get('content-length') ?? '0') > MAX_BYTES) return NextResponse.json({ error: 'too_large' }, { status: 413 });
  const raw = await req.text();
  if (raw.length > MAX_BYTES) return NextResponse.json({ error: 'too_large' }, { status: 413 });
  try {
    const r = await ingestWebhook(raw, req.headers.get('stripe-signature'));
    return NextResponse.json(r, { status: 200 });
  } catch (e) {
    if (e instanceof AppError && e.code === 'unauthenticated') return NextResponse.json({ error: 'invalid_signature' }, { status: 400 });
    if (e instanceof AppError && e.code === 'validation_failed') return NextResponse.json({ error: 'invalid_payload' }, { status: 400 });
    if (e instanceof AppError && e.code === 'provider_not_configured') return NextResponse.json({ error: 'not_configured' }, { status: 503 });
    throw e;
  }
});

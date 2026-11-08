// V3.1 §13 — GET /api/posts/:id/similar?days=30 — similar-post warnings per destination (V2 duplicate detection).
import { similarPosts } from '@social-lite/services/gov/reuse';
import { route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route<{ id: string }>(async ({ req, ctx, params }) => ({ items: await similarPosts(ctx, params.id, { lookbackDays: Number(req.nextUrl.searchParams.get('days') ?? 30) || 30 }) }));

// GET /api/posts/:id/compare?from=<version id|current|revision:<id>>&to=... — structured comparison (lazy-loaded).
import { compareVersions } from '@social-lite/services';
import { route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route<{ id: string }>(async ({ req, ctx, params }) => compareVersions(ctx, params.id, req.nextUrl.searchParams.get('from') ?? 'current', req.nextUrl.searchParams.get('to') ?? 'current'));

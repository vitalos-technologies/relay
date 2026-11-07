// GET /api/approvals/:id/reviewer-options?q= — eligible reviewers for this request (bounded search).
import { reviewerOptions } from '@social-lite/services';
import { route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route<{ id: string }>(async ({ req, ctx, params }) => reviewerOptions(ctx, params.id, req.nextUrl.searchParams.get('q') ?? ''));

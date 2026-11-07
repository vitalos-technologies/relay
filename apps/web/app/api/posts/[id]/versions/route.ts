// GET /api/posts/:id/versions — draft versions (incl. conflict copies) + immutable revisions.
import { listVersions } from '@social-lite/services';
import { route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route<{ id: string }>(async ({ ctx, params }) => listVersions(ctx, params.id));

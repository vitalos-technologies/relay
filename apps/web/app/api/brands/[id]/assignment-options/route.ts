// GET /api/brands/:id/assignment-options — people/teams entitled to this brand right now.
import { assignmentOptions } from '@social-lite/services';
import { route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route<{ id: string }>(async ({ ctx, params }) => assignmentOptions(ctx, params.id));

// POST /api/assets/:id/complete — synchronous validation + derivatives (status ready | rejected).
import { completeUpload } from '@social-lite/services/media/assets';
import { route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

export const POST = route<{ id: string }>(async ({ ctx, params }) => completeUpload(ctx, params.id));

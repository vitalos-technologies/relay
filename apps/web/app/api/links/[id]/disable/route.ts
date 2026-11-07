// V3.1 §14 — POST /api/links/:id/disable — the short link stops redirecting (404).
import { disableTrackedLink } from '@social-lite/services/gov/links';
import { route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = route<{ id: string }>(async ({ ctx, params }) => disableTrackedLink(ctx, params.id));

// POST /api/notifications/:id/open — re-check access, mark read, return the page to open. Never acts on the resource.
import { openNotification } from '@social-lite/services';
import { route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = route<{ id: string }>(async ({ ctx, params }) => openNotification(ctx, params.id));

// POST /api/content-hub/connections/:id/watch — optional Drive change notifications (manual refresh stays required).
import * as ch from '@social-lite/services/content-hub/index';
import { route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = route<{ id: string }>(async ({ ctx, params }) => ch.enableDriveWatch(ctx, params.id));

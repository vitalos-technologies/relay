// POST /api/content-hub/connections/:id/disconnect — revoke, wipe tokens, stop sync/writeback, hide previews.
import * as ch from '@social-lite/services/content-hub/index';
import { route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = route<{ id: string }>(async ({ ctx, params }) => ch.disconnectContentConnection(ctx, params.id));

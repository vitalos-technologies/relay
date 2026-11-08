// GET  /api/inbox/channels/:id/templates — cached approved WhatsApp templates (no provider call)
// POST /api/inbox/channels/:id/templates — refresh the list from Meta (inbox.manage)
import { listTemplates } from '@social-lite/services/inbox/index';
import { route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route<{ id: string }>(async ({ ctx, params }) => listTemplates(ctx, params.id, false));
export const POST = route<{ id: string }>(async ({ ctx, params }) => listTemplates(ctx, params.id, true));

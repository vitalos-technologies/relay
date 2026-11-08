// GET /api/mcp/clients/:id — consent page data (the caller's own registration only).
import { consentView } from '@social-lite/services/mcp/registry';
import { route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route<{ id: string }>(async ({ params, ctx }) => consentView(ctx, params.id));

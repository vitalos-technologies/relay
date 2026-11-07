// GET /api/mcp/intents/:id — what an MCP client asked to publish (only the person it acts for).
import { intentView } from '@social-lite/services/mcp/intents';
import { route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route<{ id: string }>(async ({ params, ctx }) => intentView(ctx, params.id));

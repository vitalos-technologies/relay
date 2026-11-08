// POST /api/mcp/intents/:id/confirm — the trusted, server-side confirmation for ONE publication intent.
// Session + CSRF + Origin (route()), same person the client acts for, authority on the brand, step-up/MFA.
import { confirmIntent } from '@social-lite/services/mcp/intents';
import { route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = route<{ id: string }>(async ({ params, ctx }) => confirmIntent(ctx, params.id));

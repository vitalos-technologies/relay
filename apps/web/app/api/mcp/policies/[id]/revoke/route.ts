// POST /api/mcp/policies/:id/revoke — revoke an automation policy (its owner, or service_accounts.manage).
import { revokePolicyGrant } from '@social-lite/services/mcp/registry';
import { route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = route<{ id: string }>(async ({ params, ctx }) => revokePolicyGrant(ctx, params.id));

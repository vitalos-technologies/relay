// POST /api/mcp/clients/:id/revoke — revoke a client (its own owner, or service_accounts.manage). Immediate.
import { z } from 'zod';
import { revokeClient } from '@social-lite/services/mcp/registry';
import { parseJson, route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const body = z.object({ reason: z.string().trim().max(200).nullish() }).strict();
export const POST = route<{ id: string }>(async ({ req, params, ctx }) => revokeClient(ctx, params.id, (await parseJson(req, body)).reason));

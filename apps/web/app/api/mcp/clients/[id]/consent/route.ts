// POST /api/mcp/clients/:id/consent — approve/edit a client for this workspace (scopes, brands). Step-up required.
import { z } from 'zod';
import { consentClient } from '@social-lite/services/mcp/registry';
import { parseJson, route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = route<{ id: string }>(async ({ req, params, ctx }) => consentClient(ctx, params.id, await parseJson(req, z.unknown())));

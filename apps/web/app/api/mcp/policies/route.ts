// GET /api/mcp/policies — automation policies · POST create (step-up; for the caller's own approved client).
import { z } from 'zod';
import { createPolicyGrant, listPolicyGrants } from '@social-lite/services/mcp/registry';
import { parseJson, route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ ctx }) => listPolicyGrants(ctx));
export const POST = route(async ({ req, ctx }) => Response.json(await createPolicyGrant(ctx, await parseJson(req, z.unknown())), { status: 201 }));

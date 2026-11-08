// GET /api/entitlements/selections — accounts/searches and which stay active under a lowered limit (billing.read or
// workspace.manage) · PUT { allowance, resource_ids } (billing.manage) — choose what stays active. Nothing is deleted or
// disconnected; audited; held work is released/held immediately.
import { z } from 'zod';
import { listSelections, setSelection } from '@social-lite/services/entitlements/usage';
import { parseJson, route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ ctx }) => listSelections(ctx));
export const PUT = route(async ({ req, ctx }) => setSelection(ctx, await parseJson(req, z.unknown())));

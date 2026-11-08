// Owner only. GET binding + signing-secret status (is_set/source only) · PUT { brand_id, acting_user_id } · DELETE (unbind). Audited.
import { deleteTipsignalBinding, getTipsignalBinding, setTipsignalBinding } from '@social-lite/services/integrations/index';
import { parseJson, route } from '@/lib/api';
import { z } from 'zod';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ ctx }) => getTipsignalBinding(ctx));
export const PUT = route(async ({ req, ctx }) => setTipsignalBinding(ctx, await parseJson(req, z.unknown())));
export const DELETE = route(async ({ ctx }) => deleteTipsignalBinding(ctx));

// POST /api/inbox/conversations/:id/customer/link { customer_id | new_customer_name, reason } — explicit, audited link.
import { linkIdentity, linkSchema } from '@social-lite/services/inbox/index';
import { parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = route<{ id: string }>(async ({ req, ctx, params }) => linkIdentity(ctx, params.id, await parseJson(req, linkSchema)));

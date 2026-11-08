// GET /api/inbox/customers?q=&brand_id= — pick an existing customer to link (picker only; never automatic).
import { searchCustomers } from '@social-lite/services/inbox/index';
import { queryOf, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ req, ctx }) => searchCustomers(ctx, queryOf(req)));

// GET /api/accounts/health?brand_id= — account health centre: per connection, why it cannot publish, the
// exact fix and the affected upcoming schedules (only brands where the viewer holds connections.read).
import { accountHealth } from '@social-lite/services/product/health';
import { route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ req, ctx }) => {
  const b = req.nextUrl.searchParams.get('brand_id');
  return accountHealth(ctx, { brand_id: b && /^[0-9a-f-]{36}$/i.test(b) ? b : null });
});

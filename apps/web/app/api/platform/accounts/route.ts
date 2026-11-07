// GET /api/platform/accounts?q= — find accounts (identity + membership counts). support+.
import { findAccounts } from '@social-lite/services/admin/platform';
import { platformRoute, queryOf } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = platformRoute(async ({ req, p }) => findAccounts(p, queryOf(req)));

// GET /api/platform/audit?workspace_id=&action=&cursor= — platform audit (append-only). support+.
import { platformAuditList } from '@social-lite/services/admin/platform';
import { platformRoute, queryOf } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = platformRoute(async ({ req, p }) => platformAuditList(p, queryOf(req)));

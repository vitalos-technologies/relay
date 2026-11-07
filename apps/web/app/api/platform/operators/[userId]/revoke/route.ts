// POST /api/platform/operators/:userId/revoke { reason } — operator, fresh. Ends their open support access.
import { z } from 'zod';
import { revokeOperator } from '@social-lite/services/admin/platform';
import { parseJson, platformRoute } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = platformRoute<{ userId: string }>(async ({ req, p, params }) => revokeOperator(p, params.userId, await parseJson(req, z.unknown())));

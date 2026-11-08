// POST /api/platform/support-access/:id/end — operator ends/cancels their own access.
import { operatorEndSupportAccess } from '@social-lite/services/admin/support-access';
import { platformRoute } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = platformRoute<{ id: string }>(async ({ p, params }) => operatorEndSupportAccess(p, params.id));

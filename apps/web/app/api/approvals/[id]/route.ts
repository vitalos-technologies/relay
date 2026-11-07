// GET /api/approvals/:id — exact outgoing variants + V2 policy progress, decisions and the caller's eligibility.
import { approvalDetailV2 } from '@social-lite/services';
import { route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route<{ id: string }>(async ({ ctx, params }) => approvalDetailV2(ctx, params.id));

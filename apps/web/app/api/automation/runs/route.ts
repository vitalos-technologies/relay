// GET /api/automation/runs?rule_id=&subject_id=&limit= → execution history (no customer text).
import { listAutomationRuns } from '@social-lite/services/automation/index';
import { queryOf, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ req, ctx }) => listAutomationRuns(ctx, queryOf(req) as never));

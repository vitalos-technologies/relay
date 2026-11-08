// GET /api/automation/admin → AI usage/budget + automation health, counts only (diagnostics.read). For the admin app (stream F).
import { aiAutomationAdminOverview } from '@social-lite/services/automation/index';
import { route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ ctx }) => aiAutomationAdminOverview(ctx));

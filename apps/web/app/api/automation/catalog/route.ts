// GET /api/automation/catalog → triggers/actions with availability, channels, categories, emergency stop (automation.manage).
import { automationCatalog } from '@social-lite/services/automation/index';
import { route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ ctx }) => automationCatalog(ctx));

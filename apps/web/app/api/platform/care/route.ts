// GET /api/platform/care — inbox, integrations, listening, AI and automation pipeline health across the installation
// (aggregates only: no workspace names, conversations, mentions or prompts). support+.
import { platformCareHealth } from '@social-lite/services/admin/v35';
import { platformRoute } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = platformRoute(async () => platformCareHealth());

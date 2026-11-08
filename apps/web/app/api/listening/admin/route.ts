// GET /api/listening/admin — coverage + ingestion health (counts/states only; workspace.read). Admin screen: stream F.
import { listeningAdminOverview } from '@social-lite/services/listening/index';
import { route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ ctx }) => listeningAdminOverview(ctx));

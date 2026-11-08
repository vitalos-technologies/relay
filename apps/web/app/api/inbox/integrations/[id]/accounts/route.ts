// GET /api/inbox/integrations/:id/accounts — numbers (WhatsApp) or selected locations (Google Business Profile) that can
// become inbox channels, with the channel already using each one. Stream B.
import { integrationAccounts } from '@social-lite/services/inbox/index';
import { route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route<{ id: string }>(async ({ ctx, params }) => integrationAccounts(ctx, params.id));

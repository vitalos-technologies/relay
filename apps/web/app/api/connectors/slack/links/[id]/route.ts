// DELETE /api/connectors/slack/links/:id — unlink (self, or integration managers)
import { unlinkSlackIdentity } from '@social-lite/services/integrations-v35/index';
import { route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const DELETE = route<{ id: string }>(async ({ ctx, params }) => { await unlinkSlackIdentity(ctx, params.id); return { ok: true }; });

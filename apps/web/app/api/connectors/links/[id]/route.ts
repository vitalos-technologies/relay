// DELETE /api/connectors/links/:id — unlink (reversible + audited; the external record is not touched)
import { unlinkExternal } from '@social-lite/services/connectors/index';
import { route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const DELETE = route<{ id: string }>(async ({ ctx, params }) => { await unlinkExternal(ctx, params.id); return { ok: true }; });

// POST /api/connectors/translate — machine translation (original kept; never sends; workspace controls + caps)
import { translate, translateSchema } from '@social-lite/services/integrations-v35/index';
import { parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = route(async ({ req, ctx }) => translate(ctx, await parseJson(req, translateSchema)));

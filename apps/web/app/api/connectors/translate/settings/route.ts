// GET /api/connectors/translate/settings · PUT — workspace control (off by default; billing acknowledged; customer content switch; cap)
import { getTranslationSettings, translationSettingsSchema, updateTranslationSettings } from '@social-lite/services/integrations-v35/index';
import { parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ ctx }) => getTranslationSettings(ctx));
export const PUT = route(async ({ req, ctx }) => updateTranslationSettings(ctx, await parseJson(req, translationSettingsSchema)));

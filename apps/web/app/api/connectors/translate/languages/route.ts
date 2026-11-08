// GET /api/connectors/translate/languages — target languages the provider supports
import { supportedTargetLanguages } from '@social-lite/services/integrations-v35/index';
import { route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ ctx }) => supportedTargetLanguages(ctx));

// POST /api/inbox/whatsapp/connect { brand_id, waba_id, phone_number_id, access_token } — protected setup form: the
// number is verified at Meta before anything is stored; the token goes to the encrypted vault and is never returned.
import { connectWhatsApp, whatsAppConnectSchema } from '@social-lite/services/inbox/index';
import { parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = route(async ({ req, ctx }) => connectWhatsApp(ctx, await parseJson(req, whatsAppConnectSchema)));

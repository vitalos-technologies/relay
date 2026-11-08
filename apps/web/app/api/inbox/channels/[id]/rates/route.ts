// PUT /api/inbox/channels/:id/rates { rates: { marketing?: {amount, currency}, … } | null } — operator-entered WhatsApp
// rate card used for the estimate shown before a charged send (Meta's rates vary by country).
import { ratesSchema, setWhatsAppRates } from '@social-lite/services/inbox/index';
import { parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const PUT = route<{ id: string }>(async ({ req, ctx, params }) => setWhatsAppRates(ctx, params.id, await parseJson(req, ratesSchema)));

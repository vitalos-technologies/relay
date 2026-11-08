// POST /api/inbox/channels/:id/telegram { action: 'check' | 'claim' | 'release', confirm_no_other_consumer? } —
// the Telegram update-ownership plan (never overwrites another app's webhook; claim needs explicit confirmation).
import { z } from 'zod';
import { checkTelegramWebhook, claimTelegramWebhook, releaseTelegramWebhook } from '@social-lite/services/inbox/index';
import { parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const schema = z.object({ action: z.enum(['check', 'claim', 'release']), confirm_no_other_consumer: z.boolean().optional() }).strict();

export const POST = route<{ id: string }>(async ({ req, ctx, params }) => {
  const b = await parseJson(req, schema);
  if (b.action === 'check') return checkTelegramWebhook(ctx, params.id);
  if (b.action === 'release') return releaseTelegramWebhook(ctx, params.id);
  return claimTelegramWebhook(ctx, params.id, { confirm_no_other_consumer: b.confirm_no_other_consumer === true } as { confirm_no_other_consumer: true });
});

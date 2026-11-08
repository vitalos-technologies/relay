// GET /api/assistant/classification?conversation_id= → latest classification (signals only) or null.
import { AppError } from '@social-lite/core';
import { conversationClassification } from '@social-lite/services/assistant/index';
import { queryOf, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ req, ctx }) => {
  const id = queryOf(req).conversation_id;
  if (!id) throw new AppError('validation_failed', 'conversation_id is required');
  return { classification: await conversationClassification(ctx, id) };
});

// Shared zod schema for bulk requests (V3.1 §11).
import { z } from 'zod';
import { BULK_MAX_ITEMS } from '@social-lite/core/contracts/v31-data';

export const bulkRequest = z.object({
  target_kind: z.enum(['post', 'asset']),
  action: z.string().max(40),
  item_ids: z.array(z.string().uuid()).min(1).max(BULK_MAX_ITEMS),
  params: z.object({
    assignee_user_id: z.string().uuid().nullable().optional(), team_id: z.string().uuid().nullable().optional(),
    tags: z.array(z.string().max(40)).max(20).optional(), campaign_id: z.string().uuid().nullable().optional(),
    shift_minutes: z.number().int().optional(),
  }).optional(),
});

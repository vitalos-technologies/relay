// Request schema for invitation rows (single and bulk). Strict: unknown keys (workspace ids, scope types,
// granted_by, sources…) are rejected — the server derives them.
import { z } from 'zod';

const grant = z.object({ role: z.string().max(40), brand_id: z.string().max(64).nullable().optional(), connection_id: z.string().max(64).nullable().optional() }).strict();

export const invitationBody = z.object({
  email: z.string().max(320),
  role: z.enum(['admin', 'editor', 'approver', 'viewer']).optional(),
  brand_ids: z.array(z.string().max(64)).max(200).optional(),
  grants: z.array(grant).max(50).optional(),
  team_ids: z.array(z.string().max(64)).max(50).optional(),
  access_expires_at: z.string().max(40).nullable().optional(),
}).strict();

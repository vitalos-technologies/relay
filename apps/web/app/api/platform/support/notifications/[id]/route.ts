// V4 Platform → Support — POST /api/platform/support/notifications/:id { read: boolean }.
import { z } from 'zod';
import { markPlatformNotification } from '@social-lite/services/support/notify';
import { parseJson, platformRoute } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = platformRoute<{ id: string }>(async ({ req, p, params }) => {
  const { read } = await parseJson(req, z.object({ read: z.boolean() }).strict());
  return markPlatformNotification(p, params.id, read);
});

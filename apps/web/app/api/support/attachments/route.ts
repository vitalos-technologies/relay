// V4 Relay support — POST /api/support/attachments { filename, content_type, size }: upload intent (private storage, quarantined until validated).
import { z } from 'zod';
import { customerUploadIntent } from '@social-lite/services/support/attachments';
import { parseJson, route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = route(async ({ req, ctx }) => customerUploadIntent(ctx, await parseJson(req, z.unknown())));

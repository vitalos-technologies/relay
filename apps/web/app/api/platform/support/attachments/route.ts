// V4 Platform → Support — POST /api/platform/support/attachments { filename, content_type, size }: staff upload intent.
import { z } from 'zod';
import { staffUploadIntent } from '@social-lite/services/support/attachments';
import { parseJson, platformRoute } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = platformRoute(async ({ req, p }) => staffUploadIntent(p, await parseJson(req, z.unknown())));

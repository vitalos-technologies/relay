// V4 Platform → Support — GET/POST /api/platform/support/saved-replies { title, body, category? }.
import { z } from 'zod';
import { createSavedReply, listSavedReplies } from '@social-lite/services/support/staff';
import { parseJson, platformRoute } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = platformRoute(async ({ p }) => listSavedReplies(p));
export const POST = platformRoute(async ({ req, p }) => createSavedReply(p, await parseJson(req, z.unknown())));

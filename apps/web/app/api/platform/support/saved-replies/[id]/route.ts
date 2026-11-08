// V4 Platform → Support — PUT /api/platform/support/saved-replies/:id { title, body, category? }; DELETE archives it.
import { z } from 'zod';
import { archiveSavedReply, updateSavedReply } from '@social-lite/services/support/staff';
import { parseJson, platformRoute } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const PUT = platformRoute<{ id: string }>(async ({ req, p, params }) => updateSavedReply(p, params.id, await parseJson(req, z.unknown())));
export const DELETE = platformRoute<{ id: string }>(async ({ p, params }) => archiveSavedReply(p, params.id));

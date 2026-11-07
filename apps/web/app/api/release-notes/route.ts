// V3.1 §16 — GET /api/release-notes — changelog for this version + unseen count. POST { version } marks seen.
import { z } from 'zod';
import { getReleaseNotes, markReleaseNotesSeen } from '@social-lite/services/gov/release';
import { parseJson, route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ ctx }) => getReleaseNotes(ctx));
export const POST = route(async ({ req, ctx }) => markReleaseNotesSeen(ctx, await parseJson(req, z.unknown())));

// POST /api/connectors/hubspot/notes { case_id, text, approved: true } — the exact approved summary as a ticket note
import { addHubspotNote, noteSchema } from '@social-lite/services/integrations-v35/index';
import { parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = route(async ({ req, ctx }) => addHubspotNote(ctx, await parseJson(req, noteSchema)));

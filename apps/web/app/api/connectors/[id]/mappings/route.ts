// GET /api/connectors/:id/mappings · PUT one mapping (synchronization contract; protected fields never two-way)
import { fieldMappingSchema, listFieldMappings, setFieldMapping } from '@social-lite/services/connectors/index';
import { parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route<{ id: string }>(async ({ ctx, params }) => listFieldMappings(ctx, params.id));
export const PUT = route<{ id: string }>(async ({ req, ctx, params }) => setFieldMapping(ctx, params.id, await parseJson(req, fieldMappingSchema)));

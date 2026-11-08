// V3.1 §12 — GET/POST /api/brands/:id/rules — list active rules / add a rule { kind, value, replacement?, severity, providers?, note? }.
import { z } from 'zod';
import { createBrandRule, getBrandProfile } from '@social-lite/services/gov/brand-rules';
import { parseJson, route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route<{ id: string }>(async ({ ctx, params }) => ({ items: (await getBrandProfile(ctx, params.id)).rules }));
export const POST = route<{ id: string }>(async ({ req, ctx, params }) => createBrandRule(ctx, params.id, await parseJson(req, z.unknown())));

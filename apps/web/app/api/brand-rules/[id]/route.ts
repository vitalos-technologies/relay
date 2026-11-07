// V3.1 §12 — PATCH/DELETE /api/brand-rules/:id — edit or archive a rule (brands.manage). Returns { rule?, impact }.
import { z } from 'zod';
import { archiveBrandRule, updateBrandRule } from '@social-lite/services/gov/brand-rules';
import { parseJson, route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const PATCH = route<{ id: string }>(async ({ req, ctx, params }) => updateBrandRule(ctx, params.id, await parseJson(req, z.unknown())));
export const DELETE = route<{ id: string }>(async ({ ctx, params }) => archiveBrandRule(ctx, params.id));

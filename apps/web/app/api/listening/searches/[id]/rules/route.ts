// GET /api/listening/searches/:id/rules — spike alert rules of a search
import { listRules } from '@social-lite/services/listening/index';
import { route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route<{ id: string }>(async ({ ctx, params }) => listRules(ctx, params.id));

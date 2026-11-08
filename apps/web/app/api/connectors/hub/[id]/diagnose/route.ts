// POST /api/connectors/hub/:id/diagnose — live health check (explicit action; result stored + shown)
import { diagnoseIntegration } from '@social-lite/services/integrations-v35/index';
import { route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = route<{ id: string }>(async ({ ctx, params }) => diagnoseIntegration(ctx, params.id));

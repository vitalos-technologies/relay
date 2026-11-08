// POST /api/connectors/tasks/:id/refresh — read the external task now (explicit)
import { refreshExternalTask } from '@social-lite/services/integrations-v35/index';
import { route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = route<{ id: string }>(async ({ ctx, params }) => refreshExternalTask(ctx, params.id));

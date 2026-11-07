// GET /api/platform/workspaces/:id — metadata + aggregates (no content). support+.
import { platformWorkspace } from '@social-lite/services/admin/platform';
import { platformRoute } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = platformRoute<{ id: string }>(async ({ p, params }) => platformWorkspace(p, params.id));

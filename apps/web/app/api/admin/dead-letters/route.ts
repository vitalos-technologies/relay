// GET /api/admin/dead-letters — this workspace's dead-lettered outbox events. workspace.manage.
import { deadLetters } from '@social-lite/services/admin/publishing';
import { route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ ctx }) => deadLetters(ctx));

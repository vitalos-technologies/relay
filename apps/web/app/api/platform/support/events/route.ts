// V4 Platform → Support — GET /api/platform/support/events?after=<id>: content-free change feed across tickets (support staff).
import { staffEvents } from '@social-lite/services/support/staff';
import { platformRoute } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = platformRoute(async ({ req, p }) => staffEvents(p, Number(req.nextUrl.searchParams.get('after') ?? 0)));

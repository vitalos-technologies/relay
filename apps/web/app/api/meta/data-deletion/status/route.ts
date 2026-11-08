import { deletionStatus } from '@social-lite/services/meta-callbacks';
import { publicRoute } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = publicRoute(async ({ req }) => deletionStatus(req.nextUrl.searchParams.get('code') ?? ''));

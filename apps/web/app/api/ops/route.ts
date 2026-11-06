import { ops } from '@social-lite/services/readmodels';
import { route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ ctx }) => ops(ctx));

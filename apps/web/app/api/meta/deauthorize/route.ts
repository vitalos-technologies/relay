// Meta "Deauthorize callback URL": <APP_BASE_URL>/api/meta/deauthorize (signed_request, form-encoded).
import { handleMetaDeauthorize } from '@social-lite/services/meta-callbacks';
import { publicRoute } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = publicRoute(async ({ req }) => handleMetaDeauthorize(new URLSearchParams(await req.text())));

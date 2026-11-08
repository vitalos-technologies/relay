// Meta "Data Deletion Request URL": <APP_BASE_URL>/api/meta/data-deletion → { url, confirmation_code }.
import { handleMetaDataDeletion } from '@social-lite/services/meta-callbacks';
import { publicRoute } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = publicRoute(async ({ req }) => handleMetaDataDeletion(new URLSearchParams(await req.text())));

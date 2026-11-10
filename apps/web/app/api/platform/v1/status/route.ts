// GET /api/platform/v1/status — installation status for the Vitalos Super Admin (ADR-044): aggregates only, Bearer token (RELAY_PLATFORM_STATUS_TOKEN), 404 when not configured, no-store.
// Server-to-server: no session, cookies or CSRF. Auth, rate limit, cache and the contract check live in the service.
import { platformStatusRequest } from '@social-lite/services/platform-status/service';
import { publicRoute } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = publicRoute(async ({ req }) => platformStatusRequest(req.headers));

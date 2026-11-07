// GET /api/platform/integrations — provider app configuration matrix (no secrets; never customer credentials). support+.
import { platformIntegrations } from '@social-lite/services/admin/platform';
import { platformRoute } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = platformRoute(async ({ p }) => platformIntegrations(p));

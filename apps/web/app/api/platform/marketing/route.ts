// GET /api/platform/marketing — Platform → Marketing configuration (any platform role; no secrets).
// PUT /api/platform/marketing { widget_enabled?, widget_staffed?, widget_in_app?, privacy_url?, terms_url?, support_email?, reason }
//   — platform operators, fresh MFA sign-in; audited. There is no public settings API: the marketing page reads this server-side.
import { z } from 'zod';
import { platformMarketingConfig, updateMarketingConfig } from '@social-lite/services/marketing/config';
import { parseJson, platformRoute } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = platformRoute(async ({ p }) => platformMarketingConfig(p));
export const PUT = platformRoute(async ({ req, p }) => updateMarketingConfig(p, await parseJson(req, z.unknown())));

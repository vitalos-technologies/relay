// GET /api/billing/catalogue — the public plan catalogue (Standard / Professional, GBP, per user per month, 14-day trial). Public.
import { publicCatalogue, TRIAL_DAYS, TRIAL_REQUIRES_CARD, CURRENCY } from '@social-lite/core/contracts/v4-plans';
import { publicRoute } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = publicRoute(async () => ({ currency: CURRENCY, trial_days: TRIAL_DAYS, trial_requires_card: TRIAL_REQUIRES_CARD, plans: publicCatalogue() }));

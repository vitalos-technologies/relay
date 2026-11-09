// GET /api/connections/:id/tiktok-creator-info — the TikTok creator's current posting settings (creator_info):
// privacy options and interactions turned off in TikTok. Read-only; the composer calls it when it shows TikTok settings.
import { getTikTokCreatorInfo } from '@social-lite/services/connections/index';
import { route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route<{ id: string }>(async ({ ctx, params }) => getTikTokCreatorInfo(ctx, params.id));

// TikTok creator settings for the composer (fix H1). TikTok's content sharing guidelines require the post page to use
// the creator's CURRENT creator_info: privacy options, and interactions the creator turned off in TikTok greyed out.
// Read-only (no content is created); a simulated (mock_) TikTok destination answers from the simulated API.
import { AppError, TransportError, invalidState } from '@social-lite/core';
import { ProviderHttpError } from '@social-lite/providers/shared/http';
import { classifyTikTok } from '@social-lite/providers/tiktok/api';
import { tiktokCreatorSettings, type TikTokCreatorSettings } from '@social-lite/providers/tiktok/adapter';
import type { Ctx } from '../context.js';
import { requireAction } from '../tenancy.js';
import { CredentialUnavailableError, getUsableCredentials } from './credentials.js';
import { buildAdapterContext } from './runtime.js';
import { loadConnection } from './store.js';

export interface TikTokCreatorInfoJson {
  connection_id: string;
  simulated: boolean;
  checked_at: string;
  creator: { nickname: string | null; username: string | null };
  privacy_level_options: TikTokCreatorSettings['privacyLevelOptions'];
  interactions: { comment_disabled: boolean; duet_disabled: boolean; stitch_disabled: boolean };
  max_video_post_duration_sec: number | null;
}

export async function getTikTokCreatorInfo(ctx: Ctx, id: string): Promise<TikTokCreatorInfoJson> {
  const c = await loadConnection(ctx, id);
  requireAction(ctx, 'drafts.edit', { brandId: c.brand_id });
  if (c.provider !== 'tiktok') throw invalidState('Creator settings are only available for TikTok accounts.');
  if (c.disconnected_at) throw invalidState('This account is disconnected. Reconnect it first.');
  let usable;
  try {
    usable = await getUsableCredentials(c.id);
  } catch (err) {
    if (err instanceof CredentialUnavailableError) throw invalidState(err.message);
    throw err;
  }
  let s: TikTokCreatorSettings;
  try {
    s = await tiktokCreatorSettings(await buildAdapterContext('tiktok', usable.connection), usable.credentials);
  } catch (err) {
    if (err instanceof ProviderHttpError) {
      const k = classifyTikTok(err, Date.now());
      if (k.kind === 'rate_limited') throw new AppError('rate_limited', 'TikTok is busy. Try again in a minute.');
      throw new AppError('provider_error', k.message);
    }
    if (err instanceof TransportError) throw new AppError('provider_error', 'Could not reach TikTok to read the creator’s settings. Try again shortly.');
    throw err;
  }
  return {
    connection_id: c.id, simulated: c.is_mock, checked_at: new Date().toISOString(),
    creator: { nickname: s.nickname, username: s.username },
    privacy_level_options: s.privacyLevelOptions,
    interactions: { comment_disabled: s.commentDisabled, duet_disabled: s.duetDisabled, stitch_disabled: s.stitchDisabled },
    max_video_post_duration_sec: s.maxVideoPostDurationSec,
  };
}

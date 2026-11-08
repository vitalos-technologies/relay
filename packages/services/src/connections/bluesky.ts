// V3 Bluesky connection with an AT Protocol APP PASSWORD (no OAuth redirect; atproto OAuth with PAR/DPoP is a
// documented next step — docs/providers/bluesky.md). Mirrors connectTelegram: verify with the provider OUTSIDE any
// transaction, then store the encrypted credential. The UI must label this "App password".
import { z } from 'zod';
import { AppError, TransportError } from '@social-lite/core';
import { getBlueskyConnector, isProviderHostAllowed } from '@social-lite/providers';
import { withTx } from '@social-lite/db';
import type { Ctx } from '../context.js';
import { assertBrand, requireAction } from '../tenancy.js';
import { log } from '../log.js';
import { extraHostsFor, setupContext } from './runtime.js';
import { toConnectionJson, upsertConnectionFromDestination, type ConnectionJson } from './store.js';

export const blueskyConnectSchema = z.object({
  handle: z.string().trim().min(3, 'Enter your Bluesky handle, e.g. name.bsky.social').max(253),
  app_password: z.string().trim().min(1, 'Paste an app password from Bluesky Settings → App passwords').max(64),
  /** Optional entryway/PDS for self-hosted accounts (https only; the transport allow-list still applies). */
  service: z.string().trim().url().startsWith('https://').max(200).optional(),
});

export async function connectBluesky(ctx: Ctx, brandId: string, body: unknown, opts: { reconnectConnectionId?: string | null } = {}): Promise<ConnectionJson> {
  // Credential change: verified MFA AND a fresh verification (step-up window).
  requireAction(ctx, 'connections.manage', { stepUp: true, message: 'Only owners and admins can connect accounts.' });
  await assertBrand(ctx, brandId);
  const input = blueskyConnectSchema.parse(body);
  // Self-hosted servers must be allow-listed by the operator first (no user-supplied outbound hosts).
  if (input.service && !isProviderHostAllowed(new URL(input.service).hostname, extraHostsFor('bluesky'))) {
    const msg = 'This Bluesky server is not enabled for Relay. Ask your administrator to allow it.';
    throw new AppError('validation_failed', msg, { service: msg });
  }
  let dest;
  try {
    dest = await getBlueskyConnector().verify(await setupContext('bluesky'), { identifier: input.handle, appPassword: input.app_password, service: input.service });
  } catch (err) {
    const e = err as Error & { code?: string; permanent?: boolean };
    if (e.name === 'OAuthFlowError') {
      if (e.permanent) throw new AppError('validation_failed', e.message, { app_password: e.message }, { code: e.code });
      throw new AppError('provider_error', e.message);
    }
    if (err instanceof TransportError) {
      log.warn('bluesky_verify_failed', { brandId, err: { name: e.name, message: e.message } });
      throw new AppError('provider_error', 'Could not reach Bluesky right now. Try again in a minute.');
    }
    throw err;
  }
  const { row } = await withTx((tx) => upsertConnectionFromDestination(tx, {
    workspaceId: ctx.access.workspaceId, brandId, provider: 'bluesky', actorUserId: ctx.actor.userId, correlationId: ctx.correlationId,
    dest, reconnectConnectionId: opts.reconnectConnectionId ?? null,
  })).catch((err) => {
    if ((err as { code?: string }).code === '23505') throw new AppError('conflict', 'This Bluesky account is already connected to this brand.');
    throw err;
  });
  return toConnectionJson(row);
}

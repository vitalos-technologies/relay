// Engine test fixtures: four simulated destinations with stored capabilities and a scripted adapter
// whose outcomes are chosen per provider/delivery, so engine invariants are tested in isolation.
import { randomUUID } from 'node:crypto';
import type {
  AdapterContext, ChannelCapabilities, Provider, PublishingAdapter, PublishOutcome, PrepareOutcome, ReconcileOutcome, ValidationResult,
} from '@social-lite/core';
import { validateVariant } from '@social-lite/core';
import type { EngineDeps } from '@social-lite/services';
import { testPool } from './helpers.js';

const base = {
  canPublish: true, canEditPublished: false, canDeletePublished: false, canReadMetrics: false, canReconcile: true,
  constraintsVersion: 'test-1', checkedAt: '2026-11-06T00:00:00Z',
};

export const CAPS: Record<Provider, ChannelCapabilities> = {
  instagram: { ...base, provider: 'instagram', formats: ['image'], constraints: { maxTextLength: 2200, maxCaptionLength: 2200, textCounting: 'codepoints', requiresMedia: true, supportsTextOnly: false, supportsLink: false, supportsButtons: false, maxButtons: 0, maxImages: 1, imageMimes: ['image/jpeg'], maxImageBytes: 8 << 20, minAspectRatio: 0.8, maxAspectRatio: 1.91, maxHashtags: 30, maxMentions: 20 } },
  facebook: { ...base, provider: 'facebook', formats: ['text', 'image'], constraints: { maxTextLength: 60000, maxCaptionLength: 60000, textCounting: 'codepoints', requiresMedia: false, supportsTextOnly: true, supportsLink: true, supportsButtons: false, maxButtons: 0, maxImages: 1, imageMimes: ['image/jpeg', 'image/png'], maxImageBytes: 10 << 20 } },
  telegram: { ...base, provider: 'telegram', formats: ['text', 'image'], canReconcile: false, constraints: { maxTextLength: 4096, maxCaptionLength: 1024, textCounting: 'utf16', requiresMedia: false, supportsTextOnly: true, supportsLink: true, supportsButtons: true, maxButtons: 8, maxImages: 1, imageMimes: ['image/jpeg', 'image/png'], maxImageBytes: 10 << 20 } },
  x: { ...base, provider: 'x', formats: ['text', 'image'], constraints: { maxTextLength: 280, maxCaptionLength: 280, textCounting: 'x_weighted', requiresMedia: false, supportsTextOnly: true, supportsLink: true, supportsButtons: false, maxButtons: 0, maxImages: 1, imageMimes: ['image/jpeg', 'image/png'], maxImageBytes: 5 << 20 } },
  // V3 providers (not seeded by default; present so the map covers every Provider).
  ...Object.fromEntries((['tiktok', 'youtube', 'linkedin', 'threads', 'pinterest', 'bluesky'] as const).map((p) => [p, {
    ...base, provider: p, formats: ['text', 'image'],
    constraints: { maxTextLength: 300, maxCaptionLength: 300, textCounting: 'codepoints', requiresMedia: false, supportsTextOnly: true, supportsLink: true, supportsButtons: false, maxButtons: 0, maxImages: 1, imageMimes: ['image/jpeg', 'image/png'], maxImageBytes: 5 << 20 },
  } satisfies ChannelCapabilities])) as Record<'tiktok' | 'youtube' | 'linkedin' | 'threads' | 'pinterest' | 'bluesky', ChannelCapabilities>,
};

export async function seedConnections(workspaceId: string, brandId: string): Promise<Record<Provider, string>> {
  const out = {} as Record<Provider, string>;
  for (const p of ['instagram', 'facebook', 'telegram', 'x'] as Provider[]) {
    const r = await testPool().query<{ id: string }>(
      `INSERT INTO connections(workspace_id, brand_id, provider, provider_account_id, display_name, username, status, is_mock, capabilities)
       VALUES ($1,$2,$3,$4,$5,$6,'ready',true,$7) RETURNING id`,
      [workspaceId, brandId, p, `mock_${p}_${randomUUID().slice(0, 8)}`, `Demo ${p}`, `demo_${p}`, JSON.stringify(CAPS[p])]);
    out[p] = r.rows[0]!.id;
  }
  return out;
}

/** A ready image asset with a jpeg_publish derivative (no bytes needed for scripted adapters). */
export async function seedReadyImage(workspaceId: string, brandId: string, w = 1080, h = 1350): Promise<string> {
  const id = randomUUID();
  await testPool().query(
    `INSERT INTO assets(id, workspace_id, brand_id, object_key, mime, bytes, width, height, status, checksum_sha256)
     VALUES ($1,$2,$3,$4,'image/png',1000,$5,$6,'ready','x')`, [id, workspaceId, brandId, `originals/${id}`, w, h]);
  await testPool().query(
    `INSERT INTO asset_derivatives(workspace_id, asset_id, variant, object_key, mime, bytes, width, height, checksum_sha256, transform_version)
     VALUES ($1,$2,'jpeg_publish',$3,'image/jpeg',900,$4,$5,'y',1)`, [workspaceId, id, `derivatives/${id}.jpg`, w, h]);
  return id;
}

export type Script = {
  prepare?: (deliveryId: string) => PrepareOutcome | Promise<PrepareOutcome>;
  publish?: (deliveryId: string, calls: number) => PublishOutcome | Promise<PublishOutcome>;
  reconcile?: (deliveryId: string) => ReconcileOutcome;
};

export interface ScriptedWorld {
  deps: EngineDeps;
  scripts: Partial<Record<Provider, Script>>;
  publishCalls: Map<string, number>;
  credentialFailures: Set<string>;
}

export function scriptedWorld(): ScriptedWorld {
  const scripts: Partial<Record<Provider, Script>> = {};
  const publishCalls = new Map<string, number>();
  const credentialFailures = new Set<string>();
  const adapter = (provider: Provider): PublishingAdapter => ({
    provider,
    capabilities: () => CAPS[provider],
    validate: (input): ValidationResult => validateVariant({ provider, connectionId: input.connection.id, constraints: CAPS[provider].constraints, text: input.variant.text, link: input.variant.link, buttons: input.variant.buttons, linkIsSeparateField: provider === 'facebook' && !input.media.length,
      media: input.media.map((m) => ({ assetId: m.assetId, status: 'ready', mime: m.mime, bytes: m.bytes, width: m.width, height: m.height })) }),
    prepare: async (_ctx, input) => scripts[provider]?.prepare?.(input.deliveryId) ?? { kind: 'ready', checkpoint: { step: 'ready', data: {} } },
    publish: async (_ctx, input) => {
      const n = (publishCalls.get(input.deliveryId) ?? 0) + 1;
      publishCalls.set(input.deliveryId, n);
      return scripts[provider]?.publish?.(input.deliveryId, n) ?? { kind: 'confirmed', providerIds: [`mock_${provider}_${n}_${input.deliveryId.slice(0, 6)}`] };
    },
    reconcile: async (_ctx, ref) => scripts[provider]?.reconcile?.(ref.deliveryId) ?? { kind: 'still_unknown', reason: 'scripted' },
    health: async () => ({ status: 'ready', checkedAt: new Date().toISOString(), message: 'ok' }),
  });
  const deps: EngineDeps = {
    adapterFor: adapter,
    getCredentials: async (connectionId) => {
      if (credentialFailures.has(connectionId)) {
        const { CredentialsUnavailable } = await import('@social-lite/services');
        throw new CredentialsUnavailable('The token was revoked. Reconnect the account.');
      }
      const r = await testPool().query<{ id: string; provider: Provider; provider_account_id: string; display_name: string; username: string; metadata: Record<string, unknown>; is_mock: boolean }>(
        `SELECT * FROM connections WHERE id=$1`, [connectionId]);
      const c = r.rows[0]!;
      return { credentials: { kind: 'mock', token: 't' }, connection: { id: c.id, provider: c.provider, providerAccountId: c.provider_account_id, displayName: c.display_name, username: c.username, metadata: c.metadata, isMock: c.is_mock } };
    },
    adapterContext: async () => ({ transport: { mode: 'mock', send: async () => { throw new Error('no network in tests'); } }, now: () => new Date(), config: {} }) as AdapterContext,
    loadMedia: async (_ws, ids) => ids.map((id) => ({ assetId: id, mime: 'image/jpeg', width: 1080, height: 1350, bytes: 900, url: `https://storage.invalid/${id}`, load: async () => new Uint8Array() })),
  };
  return { deps, scripts, publishCalls, credentialFailures };
}

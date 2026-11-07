// Provider adapter contracts (spec §12). Provider-specific behaviour lives in
// packages/providers; scheduling/engine code depends only on these interfaces.
import type { ChannelCapabilities, MediaFormat, Provider, UrlButton, ValidationResult } from './types.js';

// ------------------------------------------------------------------ transport
export interface HttpRequest {
  method: 'GET' | 'POST' | 'DELETE' | 'PUT';
  url: string;
  headers?: Record<string, string>;
  /** string (JSON / urlencoded), FormData (multipart) or raw bytes (V3 chunked/binary uploads). */
  body?: string | FormData | Uint8Array;
  timeoutMs?: number;
  /** Logical operation label for logs/metrics, e.g. 'telegram.sendPhoto'. */
  op: string;
  /**
   * true when this request may create externally visible content (final publish).
   * Transports use it to classify timeouts as ambiguous rather than retryable.
   */
  publishes?: boolean;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/**
 * Thrown by transports for network-level failures.
 * requestMayHaveBeenSent=false only when the connection was never established
 * (DNS failure, connection refused) — the only case where a publish is safely retryable.
 */
export class TransportError extends Error {
  constructor(
    message: string,
    public readonly kind: 'connect' | 'timeout' | 'reset' | 'aborted',
    public readonly requestMayHaveBeenSent: boolean,
  ) {
    super(message);
    this.name = 'TransportError';
  }
}

export interface Transport {
  readonly mode: 'live' | 'mock';
  send(req: HttpRequest): Promise<HttpResponse>;
}

// ------------------------------------------------------------------ credentials
export type ProviderCredentials =
  | { kind: 'telegram_bot'; botToken: string }
  | {
      kind: 'meta_page';
      pageAccessToken: string;      // Page token (derived from long-lived user token)
      userAccessToken?: string;
      userTokenExpiresAt?: string | null;
    }
  | {
      kind: 'oauth2';
      accessToken: string;
      refreshToken?: string | null;
      expiresAt?: string | null;    // ISO
      scope?: string;
    }
  | { kind: 'mock'; token: string }
  | {
      /** V3 Bluesky: AT Protocol app-password session (the app password is kept to re-create expired sessions). */
      kind: 'atproto_app_password';
      identifier: string;
      appPassword: string;
      did: string;
      /** Entryway / service used for createSession (e.g. https://bsky.social). */
      service: string;
      /** The account's PDS (from the DID document). */
      pdsUrl: string;
      accessJwt?: string | null;
      refreshJwt?: string | null;
      accessExpiresAt?: string | null;
    };

// ------------------------------------------------------------------ publishing
export interface PublishMedia {
  assetId: string;
  mime: string;
  width: number;
  height: number;
  bytes: number;
  /** Short-lived signed GET URL a provider can fetch (TTL covers fetch/processing/retries). */
  url: string;
  /** Load bytes for providers that require multipart upload (X, Telegram multipart). */
  load(): Promise<Uint8Array>;
  // ---- V1.1 (optional, additive): present for video publish derivatives.
  /** 'video' for video/* media; absent ⇒ inferred from mime. */
  kind?: 'image' | 'video';
  durationMs?: number | null;
  videoCodec?: string | null;
  audioCodec?: string | null;
  frameRate?: number | null;
  /** Signed URL of a JPEG poster frame (Reel cover etc.), when available. */
  posterUrl?: string | null;
}

export interface PublishConnection {
  id: string;
  provider: Provider;
  providerAccountId: string;
  displayName: string;
  username?: string | null;
  metadata: Record<string, unknown>;
  isMock: boolean;
}

export interface PublishInput {
  deliveryId: string;
  attemptNumber: number;
  /** Stable key for providers that support client idempotency. */
  idempotencyKey: string;
  connection: PublishConnection;
  credentials: ProviderCredentials;
  variant: {
    text: string;
    link: string | null;
    format: MediaFormat;
    buttons: UrlButton[];
    options: Record<string, unknown>;
  };
  media: PublishMedia[];
}

/** Recoverable checkpoint persisted on deliveries.preparation between steps. */
export interface Checkpoint {
  step: string;
  data: Record<string, unknown>;
  /** Provider-side expiry of the prepared object, if any (e.g. IG container ~24h). */
  expiresAt?: string | null;
}

export type PrepareOutcome =
  | { kind: 'ready'; checkpoint: Checkpoint }
  | { kind: 'pending'; checkpoint: Checkpoint; checkAfterMs: number }  // poll again
  | { kind: 'retryable'; code: string; message: string; retryAfterMs?: number; checkpoint?: Checkpoint }
  | { kind: 'permanent'; code: string; message: string; blocking?: BlockingReason };

export type BlockingReason = 'reconnect' | 'permission' | 'budget' | 'rate_limit';

export type PublishOutcome =
  | { kind: 'confirmed'; providerIds: string[]; url?: string | null; publishedAt?: string | null }
  | { kind: 'processing'; providerIds: string[]; checkAfterMs: number; checkpoint?: Checkpoint }
  | { kind: 'rejected_safe_to_retry'; code: string; message: string; retryAfterMs?: number }
  | { kind: 'permanent_failure'; code: string; message: string; blocking?: BlockingReason }
  | { kind: 'unknown'; code: string; message: string; providerIds?: string[] };

export interface AttemptReference {
  deliveryId: string;
  connection: PublishConnection;
  credentials: ProviderCredentials;
  variantText: string;
  /** Provider IDs already known (e.g. returned by a late worker, or a processing container). */
  providerIds: string[];
  checkpoint: Checkpoint | null;
  /** When the ambiguous send started — reconciliation searches around it. */
  sentAt: string | null;
}

export type ReconcileOutcome =
  | { kind: 'published'; providerIds: string[]; url?: string | null; publishedAt?: string | null }
  | { kind: 'processing'; checkAfterMs: number }
  | { kind: 'not_published'; reason: string }
  | { kind: 'still_unknown'; reason: string }
  | { kind: 'unsupported'; reason: string };

export interface ConnectionHealth {
  status: 'ready' | 'missing_permission' | 'expiring' | 'reconnect_required';
  checkedAt: string;
  /** Safe, user-facing explanation and the exact fix. */
  message: string;
  missingPermissions?: string[];
  expiresAt?: string | null;
  /** Updated non-secret metadata (e.g. display name changed). */
  metadata?: Record<string, unknown>;
}

export interface AdapterContext {
  transport: Transport;
  now(): Date;
  /** Provider app configuration (client id etc.). Secrets are never logged. */
  config: ProviderAppConfig;
}

export interface PublishingAdapter {
  readonly provider: Provider;
  capabilities(connection: PublishConnection): ChannelCapabilities;
  /** Pure validation of an outgoing variant against provider constraints. */
  validate(input: Pick<PublishInput, 'variant' | 'media' | 'connection'>): ValidationResult;
  prepare(ctx: AdapterContext, input: PublishInput, checkpoint: Checkpoint | null): Promise<PrepareOutcome>;
  publish(ctx: AdapterContext, input: PublishInput, checkpoint: Checkpoint | null): Promise<PublishOutcome>;
  /** Check a processing post or resolve an Unknown outcome. Must never create content. */
  reconcile(ctx: AdapterContext, ref: AttemptReference): Promise<ReconcileOutcome>;
  health(ctx: AdapterContext, connection: PublishConnection, credentials: ProviderCredentials): Promise<ConnectionHealth>;
  /** Refresh rotating credentials. Callers serialize per connection. */
  refreshCredentials?(ctx: AdapterContext, credentials: ProviderCredentials): Promise<{ credentials: ProviderCredentials; expiresAt: string | null; scopes?: string[] }>;
  /**
   * V3: cancel a provider-native scheduled release (scheduling owner = provider, e.g. YouTube publishAt).
   * Must report residual risk honestly: 'uncertain' when cancellation could not be confirmed.
   */
  cancelRemoteSchedule?(ctx: AdapterContext, ref: AttemptReference): Promise<RemoteScheduleCancelOutcome>;
}

/** V3: result of cancelling a provider-native schedule. */
export type RemoteScheduleCancelOutcome =
  | { kind: 'cancelled'; message: string }
  /** The scheduled time already passed / the content is already public. */
  | { kind: 'too_late'; message: string }
  /** Could not confirm: the scheduled publication may still happen (residual risk shown to the user). */
  | { kind: 'uncertain'; message: string; scheduledFor?: string | null }
  | { kind: 'unsupported'; message: string };

// ------------------------------------------------------------------ connection setup
export interface ProviderAppConfig {
  /** OAuth client id / Meta app id. Absent => provider "Not configured". */
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
  /** Pinned API version where the provider versions its API (Meta Graph). */
  apiVersion?: string;
  /** Override base URLs (tests / regional endpoints). */
  baseUrls?: Record<string, string>;
  /** V3: operator feature flags (e.g. LinkedIn organization access, Pinterest access tier). */
  features?: Record<string, string | boolean>;
}

export interface OAuthTokenSet {
  accessToken: string;
  refreshToken?: string | null;
  expiresAt?: string | null;
  scopes: string[];
  raw?: Record<string, unknown>; // never persisted unencrypted, never logged
}

export interface DestinationCandidate {
  /** Provider account identifier of the destination (page id, IG user id, X user id). */
  providerAccountId: string;
  displayName: string;
  username?: string | null;
  provider: Provider;
  /** Why it cannot be selected, if it cannot (e.g. missing CREATE_CONTENT task). */
  unavailableReason?: string | null;
  metadata: Record<string, unknown>;
}

export interface FinalizedDestination {
  providerAccountId: string;
  displayName: string;
  username?: string | null;
  credentials: ProviderCredentials;
  grantedScopes: string[];
  expiresAt: string | null;
  refreshExpiresAt?: string | null;
  metadata: Record<string, unknown>;
  health: ConnectionHealth;
}

export interface OAuthConnector {
  readonly provider: Provider;
  readonly requiredScopes: string[];
  readonly usesPkce: boolean;
  isConfigured(config: ProviderAppConfig): boolean;
  authorizationUrl(config: ProviderAppConfig, p: { state: string; codeChallenge?: string; redirectUri: string }): string;
  exchangeCode(ctx: AdapterContext, p: { code: string; codeVerifier?: string; redirectUri: string }): Promise<OAuthTokenSet>;
  listDestinations(ctx: AdapterContext, tokens: OAuthTokenSet): Promise<DestinationCandidate[]>;
  finalize(ctx: AdapterContext, tokens: OAuthTokenSet, candidate: DestinationCandidate): Promise<FinalizedDestination>;
}

export interface TelegramConnector {
  readonly provider: 'telegram';
  /** Verify bot identity, resolve channel, confirm the bot may post. Must not modify webhooks. */
  verify(ctx: AdapterContext, p: { botToken: string; channel: string }): Promise<FinalizedDestination>;
}

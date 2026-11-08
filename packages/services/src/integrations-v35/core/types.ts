// Per-connector adapter contract for the Integrations hub (stream C). Each connector folder exports one HubAdapter.
import type { AvailableResourceJson, HubConnector } from '@social-lite/core/contracts/v35-integrations';
import type { IntegrationStatus } from '@social-lite/core/contracts/v35-connectors';
import type { BizTransport } from '@social-lite/providers/biz/transport';
import type { SimHandler } from '@social-lite/providers/biz/sim';
import type { SettingKey } from '../../settings.js';

export interface OperatorConfig { values: Partial<Record<SettingKey, string>>; redirectUri: string }

export interface StoredCreds { accessToken: string; refreshToken: string | null; expiresAt: string | null }

/** Identity verified right after the OAuth exchange (before anything is saved). */
export interface ConnectIdentity {
  externalAccountId: string;
  displayName: string;
  grantedScopes: string[];
  creds: StoredCreds;
  settings?: Record<string, unknown>;
  health: { status: IntegrationStatus; message: string };
}

/** A usable installation: transport + current token. */
export interface Conn {
  integrationId: string;
  workspaceId: string;
  brandId: string | null;
  connector: HubConnector;
  externalAccountId: string;
  settings: Record<string, unknown>;
  simulated: boolean;
  t: BizTransport;
  token: string;
}

export interface HubAdapter {
  connector: HubConnector;
  hosts: readonly string[];
  sim: SimHandler;
  /** Operator settings that must be present before anyone can connect. */
  required: readonly SettingKey[];
  optional?: readonly SettingKey[];
  /** Webhook URL operators register with the provider (null: none / per installation). */
  webhook: 'global' | 'per_installation' | null;
  /** Short capability list shown in the hub. */
  capabilities: readonly string[];
  /** 'oauth' (redirect), 'operator' (workspace admin connects using operator credentials, e.g. Translation). */
  connect: 'oauth' | 'operator';
  pkce?: boolean;
  authorizeUrl?(cfg: OperatorConfig, p: { state: string; codeChallenge: string; loginHint?: string | null }): string;
  exchange?(t: BizTransport, cfg: OperatorConfig, p: { code: string; codeVerifier: string }): Promise<ConnectIdentity>;
  /** Operator-credential connect (no OAuth). */
  operatorConnect?(t: BizTransport, cfg: OperatorConfig): Promise<ConnectIdentity>;
  /** Mint/refresh an access token. Return null when the stored token is still good or cannot be refreshed. */
  refresh?(t: BizTransport, cfg: OperatorConfig, creds: StoredCreds): Promise<StoredCreds | null>;
  /** Health check (diagnose). Never "active" just because a token exists. */
  verify(c: Conn): Promise<{ status: IntegrationStatus; message: string }>;
  /** Resources available for explicit selection. `parent` narrows (e.g. Asana workspace → projects). */
  discover(c: Conn, p: { type?: string | null; parent?: string | null }): Promise<AvailableResourceJson[]>;
  revoke?(c: Conn): Promise<void>;
  /** Settings for a simulated installation (e.g. Mailchimp data centre). */
  simSettings?: Record<string, unknown>;
}

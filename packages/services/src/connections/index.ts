// Connections service (accounts): OAuth flows, Telegram verification, simulated destinations,
// health, pause/disconnect/reconnect, and credential access for the delivery engine.
export {
  getUsableCredentials, CredentialUnavailableError, markReconnectRequired, refreshStats, REFRESH_SKEW_MS,
  type CredentialUnavailableCode, type UsableConnection,
} from './credentials.js';
export {
  buildAdapterContext, setupContext, providerAppConfig, oauthRedirectUri, setLiveTransportFactoryForTests, isOAuthProvider,
  OAUTH_PROVIDERS, type OAuthProvider,
} from './runtime.js';
export {
  startOAuth, handleOAuthCallback, getConnectionFlow, selectConnectionFlow, oauthConnectorFor, selectFlowSchema,
  OAUTH_STATE_TTL_MS, CONNECTION_FLOW_TTL_MS, type OAuthCallbackError,
} from './oauth.js';
export {
  listProviderStatus, listConnections, listWorkspaceConnections, getConnection, connectTelegram, connectMock, setMockScenario,
  checkConnection, performHealthCheck, applyHealth, runHealthChecks, setConnectionPaused, disconnectConnection, reconnectConnection,
  telegramConnectSchema, mockConnectSchema, mockScenarioSchema, pauseSchema, reconnectSchema, type ProviderStatusJson,
} from './manage.js';
export {
  toConnectionJson, toPublishConnection, effectiveStatus, loadConnection, upsertConnectionFromDestination,
  type ConnectionJson, type ConnectionRow as ConnectionStoreRow,
} from './store.js';

// Production wiring of the engine's integration points: real adapters (registry), credentials
// (connections service: decrypt + serialized refresh), adapter context (live or mock transport chosen
// strictly by the connection's is_mock flag) and media (signed URLs for publish derivatives).
import { getAdapter } from '@social-lite/providers';
import { getPool } from '@social-lite/db';
import { buildAdapterContext, CredentialUnavailableError, getUsableCredentials } from '../connections/index.js';
import { loadPublishMedia } from '../media/index.js';
import { CredentialsUnavailable, type EngineDeps } from './process.js';

export function liveEngineDeps(): EngineDeps {
  return {
    adapterFor: getAdapter,
    async getCredentials(connectionId, opts) {
      try {
        const r = await getUsableCredentials(connectionId, opts);
        return { credentials: r.credentials, connection: r.connection };
      } catch (err) {
        if (err instanceof CredentialUnavailableError) {
          throw new CredentialsUnavailable(err.message, err.blocking);
        }
        throw err;
      }
    },
    adapterContext: (provider, connection) => buildAdapterContext(provider, connection),
    loadMedia: (workspaceId, assetIds) => loadPublishMedia(getPool(), workspaceId, assetIds),
  };
}

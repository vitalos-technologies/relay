// V3.5 stream C — business integrations. Importing this module registers the hub adapters, sync executors, inbound
// handlers, webhook verifiers (GBP Pub/Sub OIDC, Mailchimp signature/URL key) and inbox hooks (Slack alerts).
// It is imported by the web app's integration routes + the generic webhook ingress, and by the worker.
import { registerHubAdapter } from './core/runtime.js';
import { asanaAdapter } from './asana/adapter.js';
import { mondayAdapter } from './monday/adapter.js';
import { hubspotAdapter, registerHubspot } from './hubspot/service.js';
import { gbpAdapter, registerGbp } from './gbp/service.js';
import { translateAdapter } from './translate/service.js';
import { registerSlack, slackAdapter } from './slack/service.js';
import { mailchimpAdapter, registerMailchimp } from './mailchimp/service.js';
import { registerTaskSync } from './work/tasks.js';
import { registerAutomationExecutors } from './automation.js';

let registered = false;
export function registerIntegrationsV35(): void {
  if (registered) return;
  registered = true;
  for (const a of [asanaAdapter, mondayAdapter, hubspotAdapter, gbpAdapter, translateAdapter, slackAdapter, mailchimpAdapter]) registerHubAdapter(a);
  registerTaskSync();
  registerHubspot();
  registerGbp();
  registerSlack();
  registerMailchimp();
  registerAutomationExecutors();   // stream E automation action kinds
}
registerIntegrationsV35();

/** Test seam: the foundation's resetConnectorRegistrationsForTests clears executors/handlers; call this to restore. */
export function reregisterIntegrationsV35ForTests(): void { registered = false; registerIntegrationsV35(); }

export * from './core/hub.js';
export { openConn, operatorConfig, simulationAllowed } from './core/runtime.js';
export * from './work/tasks.js';
export * from './work/webhooks.js';
export * from './hubspot/service.js';
export * from './gbp/service.js';
export * from './translate/service.js';
export * from './slack/service.js';
export * from './mailchimp/service.js';

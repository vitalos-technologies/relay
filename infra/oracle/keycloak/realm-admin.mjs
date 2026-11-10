#!/usr/bin/env node
// Relay — live realm changes for the passwordless sign-in (D34), driven by infra/oracle/admin.sh.
//
//   node realm-admin.mjs passwordless       [--kc-url http://localhost:8080] [--realm relay] [--public-url https://auth.example]
//   node realm-admin.mjs passwordless-undo  [...]
//   node realm-admin.mjs google-signin      [...]
//
// The realm template is imported once, so an existing installation is migrated through the Keycloak Admin REST API here.
// Idempotent: running it again changes nothing that is already right.
// Secrets arrive on stdin only, one per line, never in argv or the environment, and are never printed:
//   line 1 admin username · line 2 admin password · line 3 admin two-step code (may be empty)
//   google-signin only: line 4 Google OAuth client ID · line 5 Google OAuth client secret
// Output: "OK …" / "WARN …" / "ERR <CODE> …" lines for admin.sh. Exit 0 done, 2 refused (nothing changed), 3 sign-in to
// Keycloak failed, 1 other error.
import { createInterface } from 'node:readline';

const NEW_FLOW = 'relay passwordless browser';
const BROKER_FLOW = 'relay first broker login';
const PREV_ATTR = 'relay.previousBrowserFlow';
const PROVIDERS = ['relay-email-sign-in', 'relay-idp-verified-email-link'];

const args = process.argv.slice(2);
const cmd = args[0];
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i > 0 && args[i + 1] ? args[i + 1] : dflt; };
const KC = opt('kc-url', 'http://localhost:8080').replace(/\/$/, '');
const REALM = opt('realm', 'relay');
const PUBLIC = (opt('public-url', '') || '').replace(/\/$/, '');

const out = (s) => process.stdout.write(`${s}\n`);
class Refused extends Error { constructor(code, msg) { super(msg); this.code = code; } }

async function readSecrets() {
  const lines = [];
  if (process.stdin.isTTY) return lines;
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const l of rl) lines.push(l);
  return lines;
}

let token = '';
async function signIn(user, password, otp) {
  const body = new URLSearchParams({ grant_type: 'password', client_id: 'admin-cli', username: user ?? '', password: password ?? '' });
  if (otp) body.set('totp', otp);
  const r = await fetch(`${KC}/realms/master/protocol/openid-connect/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) {
    const d = String(j.error_description ?? j.error ?? r.status);
    throw Object.assign(new Error(/not fully set up/i.test(d)
      ? 'this admin account still has a setup step (e.g. two-step) — sign in to the admin console once first'
      : /totp|otp/i.test(d) ? 'two-step code missing or wrong' : 'admin username or password not accepted'), { exitCode: 3 });
  }
  token = j.access_token;
}

async function api(method, path, body) {
  const r = await fetch(`${KC}/admin/realms/${encodeURIComponent(REALM)}${path}`, {
    method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (r.status === 404 && method === 'GET') return null;
  if (!r.ok) throw new Error(`${method} ${path.replace(/\?.*$/, '')} → HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}
const enc = encodeURIComponent;

// ------------------------------------------------------------------ flow building blocks
async function executions(flowAlias) { return (await api('GET', `/authentication/flows/${enc(flowAlias)}/executions`)) ?? []; }
async function flowExists(alias) { return ((await api('GET', '/authentication/flows')) ?? []).some((f) => f.alias === alias); }

async function addExecution(flow, provider, requirement, config) {
  await api('POST', `/authentication/flows/${enc(flow)}/executions/execution`, { provider });
  const ex = (await executions(flow)).filter((e) => e.level === 0 && e.providerId === provider).pop();
  if (!ex) throw new Error(`could not add ${provider} to ${flow}`);
  if (ex.requirement !== requirement) await api('PUT', `/authentication/flows/${enc(flow)}/executions`, { ...ex, requirement });
  if (config) await api('POST', `/authentication/executions/${ex.id}/config`, config);
}

async function addSubflow(parent, alias, requirement, description = '') {
  await api('POST', `/authentication/flows/${enc(parent)}/executions/flow`, { alias, type: 'basic-flow', provider: 'registration-page-form', description });
  const ex = (await executions(parent)).find((e) => e.level === 0 && e.authenticationFlow && e.displayName === alias);
  if (!ex) throw new Error(`could not add sub-flow ${alias}`);
  if (ex.requirement !== requirement) await api('PUT', `/authentication/flows/${enc(parent)}/executions`, { ...ex, requirement });
}

async function deleteFlowTree(alias) {
  const flows = (await api('GET', '/authentication/flows')) ?? [];
  const f = flows.find((x) => x.alias === alias);
  if (f) await api('DELETE', `/authentication/flows/${f.id}`);
}

/** Cookie, else: LoA 1 = email link + 6-digit code (relay-auth); LoA 2 = authenticator app / passkey / recovery code. */
async function ensureBrowserFlow(realm) {
  if (await flowExists(NEW_FLOW)) {
    const ex = await executions(NEW_FLOW);
    if (ex.some((e) => e.providerId === 'relay-email-sign-in') && ex.some((e) => e.providerId === 'auth-otp-form')) { out(`OK flow "${NEW_FLOW}" present`); return; }
    if (realm.browserFlow === NEW_FLOW) throw new Error(`flow "${NEW_FLOW}" is bound but incomplete; fix it in the admin console`);
    out(`WARN flow "${NEW_FLOW}" was incomplete (earlier interrupted run); rebuilding it`);
    await deleteFlowTree(NEW_FLOW);
  }
  const f = NEW_FLOW;
  await api('POST', '/authentication/flows', { alias: f, description: 'Relay (D34): cookie, else email link + code (LoA 1); second factor only when acr mfa (LoA 2) is requested', providerId: 'basic-flow', topLevel: true, builtIn: false });
  await addExecution(f, 'auth-cookie', 'ALTERNATIVE');
  await addSubflow(f, 'relay passwordless forms', 'ALTERNATIVE', 'Level-of-authentication conditional forms');
  await addSubflow('relay passwordless forms', 'relay passwordless loa1', 'CONDITIONAL', 'LoA 1: email sign-in (link or 6-digit code)');
  await addExecution('relay passwordless loa1', 'conditional-level-of-authentication', 'REQUIRED', { alias: 'relay-loa1', config: { 'loa-condition-level': '1', 'loa-max-age': '43200' } });
  await addExecution('relay passwordless loa1', 'relay-email-sign-in', 'REQUIRED', { alias: 'relay-email-sign-in', config: { 'relay.ttl.seconds': '900', 'default.reference.value': 'email', 'default.reference.maxAge': '43200' } });
  await addSubflow('relay passwordless forms', 'relay passwordless loa2', 'CONDITIONAL', 'LoA 2: second factor (always asked again: max age 0)');
  await addExecution('relay passwordless loa2', 'conditional-level-of-authentication', 'REQUIRED', { alias: 'relay-loa2', config: { 'loa-condition-level': '2', 'loa-max-age': '0' } });
  await addExecution('relay passwordless loa2', 'conditional-user-configured', 'REQUIRED');
  await addSubflow('relay passwordless loa2', 'relay passwordless second factor', 'REQUIRED', 'Authenticator app, passkey or recovery code');
  await addExecution('relay passwordless second factor', 'auth-otp-form', 'ALTERNATIVE', { alias: 'relay-amr-otp', config: { 'default.reference.value': 'otp', 'default.reference.maxAge': '43200' } });
  await addExecution('relay passwordless second factor', 'webauthn-authenticator', 'ALTERNATIVE', { alias: 'relay-amr-hwk', config: { 'default.reference.value': 'hwk', 'default.reference.maxAge': '43200' } });
  await addExecution('relay passwordless second factor', 'auth-recovery-authn-code-form', 'ALTERNATIVE', { alias: 'relay-amr-rc', config: { 'default.reference.value': 'rc', 'default.reference.maxAge': '43200' } });
  out(`OK created flow "${NEW_FLOW}"`);
}

/** First sign-in with Google: link an existing account only on a Google-verified email; create only with self-registration. */
async function ensureBrokerFlow() {
  if (await flowExists(BROKER_FLOW)) {
    if ((await executions(BROKER_FLOW)).some((e) => e.providerId === 'relay-idp-verified-email-link')) { out(`OK flow "${BROKER_FLOW}" present`); return; }
    out(`WARN flow "${BROKER_FLOW}" was incomplete; rebuilding it`);
    await deleteFlowTree(BROKER_FLOW);
  }
  await api('POST', '/authentication/flows', { alias: BROKER_FLOW, description: 'Relay (D34): first sign-in with Google', providerId: 'basic-flow', topLevel: true, builtIn: false });
  await addExecution(BROKER_FLOW, 'idp-review-profile', 'REQUIRED', { alias: 'relay review profile', config: { 'update.profile.on.first.login': 'missing' } });
  await addSubflow(BROKER_FLOW, 'relay first broker link or create', 'REQUIRED');
  await addExecution('relay first broker link or create', 'relay-idp-verified-email-link', 'ALTERNATIVE');
  await addExecution('relay first broker link or create', 'idp-create-user-if-unique', 'ALTERNATIVE', { alias: 'relay create unique user', config: { 'require.password.update.after.registration': 'false' } });
  out(`OK created flow "${BROKER_FLOW}"`);
}

const GOOGLE_DEFAULTS = { alias: 'google', displayName: 'Google', providerId: 'google', trustEmail: true, storeToken: false, addReadTokenRoleOnCreate: false,
  authenticateByDefault: false, linkOnly: false, hideOnLogin: false, firstBrokerLoginFlowAlias: BROKER_FLOW };

async function ensureGoogle(credentials) {
  const cur = await api('GET', '/identity-provider/instances/google');
  if (!cur) {
    await api('POST', '/identity-provider/instances', { ...GOOGLE_DEFAULTS, enabled: false,
      config: { clientId: 'not-configured', clientSecret: 'not-configured', syncMode: 'IMPORT', defaultScope: 'openid email profile', guiOrder: '1' } });
    out('OK Google sign-in added (off until you run: admin.sh google-signin)');
  } else if (cur.firstBrokerLoginFlowAlias !== BROKER_FLOW || cur.trustEmail !== true) {
    await api('PUT', '/identity-provider/instances/google', { ...cur, firstBrokerLoginFlowAlias: BROKER_FLOW, trustEmail: true });
    out('OK Google sign-in uses the Relay first-sign-in rules');
  } else out(`OK Google sign-in present (${cur.enabled ? 'on' : 'off'})`);
  if (credentials) {
    const now = await api('GET', '/identity-provider/instances/google');
    await api('PUT', '/identity-provider/instances/google', { ...now, ...GOOGLE_DEFAULTS, enabled: true,
      config: { ...now.config, clientId: credentials.clientId, clientSecret: credentials.clientSecret, syncMode: 'IMPORT', defaultScope: 'openid email profile' } });
    out('OK Google sign-in configured and switched on');
  }
}

async function setRequiredAction(alias, enabled) {
  const ra = await api('GET', `/authentication/required-actions/${enc(alias)}`);
  if (!ra) return;
  if (ra.enabled !== enabled) { await api('PUT', `/authentication/required-actions/${enc(alias)}`, { ...ra, enabled }); out(`OK required action ${alias} ${enabled ? 'on' : 'off'}`); }
}

// Every password step in every flow (bound or not) goes off: Keycloak's account console lists "Password" whenever any
// top-level flow still contains one. What was on is recorded so --undo can put it back exactly.
const PASSWORD_STEPS = ['auth-username-password-form', 'auth-password-form', 'direct-grant-validate-password', 'reset-password', 'idp-username-password-form'];
const PW_ATTR = 'relay.passwordSteps';

async function disablePasswordSteps() {
  const changed = [];
  for (const f of ((await api('GET', '/authentication/flows')) ?? []).filter((x) => x.topLevel)) {
    for (const e of await executions(f.alias)) {
      if (PASSWORD_STEPS.includes(e.providerId) && e.requirement !== 'DISABLED') {
        await api('PUT', `/authentication/flows/${enc(f.alias)}/executions`, { ...e, requirement: 'DISABLED' });
        changed.push({ flow: f.alias, id: e.id, requirement: e.requirement });
      }
    }
  }
  if (changed.length) out(`OK password steps off in ${[...new Set(changed.map((c) => `"${c.flow}"`))].join(', ')}`);
  return changed;
}

async function restorePasswordSteps(recorded) {
  for (const r of recorded) {
    const e = (await executions(r.flow)).find((x) => x.id === r.id);
    if (e && e.requirement === 'DISABLED') await api('PUT', `/authentication/flows/${enc(r.flow)}/executions`, { ...e, requirement: r.requirement });
  }
  if (recorded.length) out(`OK password steps restored (${recorded.length})`);
}

async function webClient() {
  const clients = (await api('GET', '/clients?max=200')) ?? [];
  return clients.find((c) => c.clientId === 'relay-web') ?? clients.find((c) => (c.redirectUris ?? []).some((u) => u.endsWith('/api/auth/callback')));
}

async function fixWebClient() {
  const c = await webClient();
  if (!c) { out('WARN Relay web client not found; check post-logout redirect URIs by hand'); return; }
  const cb = (c.redirectUris ?? []).find((u) => u.endsWith('/api/auth/callback'));
  if (!cb) { out(`WARN client ${c.clientId} has no /api/auth/callback redirect URI`); return; }
  const app = cb.replace(/\/api\/auth\/callback$/, '');
  const attrs = { ...(c.attributes ?? {}) };
  const uris = new Set(String(attrs['post.logout.redirect.uris'] ?? '').split('##').filter(Boolean));
  const before = uris.size;
  uris.add(`${app}/`); uris.add(`${app}/login`);
  const changed = uris.size !== before || c.baseUrl !== `${app}/` || c.directAccessGrantsEnabled;
  if (changed) {
    attrs['post.logout.redirect.uris'] = [...uris].join('##');
    await api('PUT', `/clients/${c.id}`, { ...c, attributes: attrs, baseUrl: `${app}/`, directAccessGrantsEnabled: false });
    out(`OK client ${c.clientId}: sign-out returns to ${app}/, no password grant`);
  } else out(`OK client ${c.clientId} already set`);
}

// ------------------------------------------------------------------ commands
async function passwordless() {
  const realm = await api('GET', '');
  if (!realm) throw new Refused('NO_REALM', `realm "${REALM}" not found`);
  const smtp = realm.smtpServer ?? {};
  if (!smtp.host || !smtp.from) throw new Refused('NO_SMTP', 'the realm has no SMTP server, so sign-in emails cannot be sent');
  const providers = ((await api('GET', '/authentication/authenticator-providers')) ?? []).map((p) => p.id);
  const missing = PROVIDERS.filter((p) => !providers.includes(p));
  if (missing.length) throw new Refused('NO_PROVIDER', `the sign-in server image does not have ${missing.join(', ')} yet`);
  const info = await fetch(`${KC}/admin/serverinfo`, { headers: { authorization: `Bearer ${token}` } }).then((r) => r.json()).catch(() => ({}));
  const themes = info?.themes ?? {};
  if (!(themes.login ?? []).some((t) => t.name === 'relay') || !(themes.email ?? []).some((t) => t.name === 'relay')) throw new Refused('NO_THEME', 'the Relay login/email theme is not installed in the sign-in server image yet');

  await ensureBrowserFlow(realm);
  await ensureBrokerFlow();
  await ensureGoogle(null);
  await setRequiredAction('UPDATE_PASSWORD', false);
  await setRequiredAction('VERIFY_PROFILE', false);
  await setRequiredAction('CONFIGURE_TOTP', true);
  const steps = await disablePasswordSteps();
  await fixWebClient();

  const fresh = await api('GET', '');
  const attributes = { ...(fresh.attributes ?? {}) };
  if (fresh.browserFlow !== NEW_FLOW) attributes[PREV_ATTR] = fresh.browserFlow;
  if (steps.length) {
    let before = [];
    try { before = JSON.parse(attributes[PW_ATTR] ?? '[]'); } catch { before = []; }
    const seen = new Set(before.map((b) => b.id));
    attributes[PW_ATTR] = JSON.stringify([...before, ...steps.filter((x) => !seen.has(x.id))]);
  }
  await api('PUT', '', { realm: fresh.realm, browserFlow: NEW_FLOW, loginTheme: 'relay', emailTheme: 'relay', resetPasswordAllowed: false,
    registrationEmailAsUsername: true, loginWithEmailAllowed: true, duplicateEmailsAllowed: false, attributes });
  const done = await api('GET', '');
  if (done.browserFlow !== NEW_FLOW || done.loginTheme !== 'relay') throw new Error('realm did not take the new settings');
  out(`OK sign-in is passwordless (browser flow "${NEW_FLOW}"${attributes[PREV_ATTR] ? `; previous "${attributes[PREV_ATTR]}" kept for --undo` : ''})`);
  out(`OK self-registration is ${done.registrationAllowed ? 'ON (new emails create accounts)' : 'off (only existing accounts / invitations)'}`);
}

async function undo() {
  const realm = await api('GET', '');
  if (!realm) throw new Refused('NO_REALM', `realm "${REALM}" not found`);
  const prev = realm.attributes?.[PREV_ATTR];
  if (realm.browserFlow !== NEW_FLOW) { out(`OK already on "${realm.browserFlow}" — nothing to undo`); return; }
  if (!prev || !(await flowExists(prev))) throw new Refused('NO_PREVIOUS', 'no earlier browser flow is recorded (this realm started passwordless)');
  let recorded = [];
  try { recorded = JSON.parse(realm.attributes?.[PW_ATTR] ?? '[]'); } catch { recorded = []; }
  await restorePasswordSteps(recorded);
  const attributes = { ...(realm.attributes ?? {}) };
  delete attributes[PW_ATTR];
  await api('PUT', '', { realm: realm.realm, browserFlow: prev, attributes });
  await setRequiredAction('UPDATE_PASSWORD', true);
  out(`OK browser flow back to "${prev}" (password sign-in). Accounts created after the switch have no password: set one in the admin console if needed.`);
}

async function googleSignin(clientId, clientSecret) {
  if (!clientId || !/^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(clientId)) throw new Refused('BAD_INPUT', 'that does not look like a Google OAuth client ID (…apps.googleusercontent.com)');
  if (!clientSecret || clientSecret.length < 10) throw new Refused('BAD_INPUT', 'client secret missing');
  const realm = await api('GET', '');
  if (!realm) throw new Refused('NO_REALM', `realm "${REALM}" not found`);
  await ensureBrokerFlow();
  await ensureGoogle({ clientId, clientSecret });
  if (realm.browserFlow !== NEW_FLOW) out('WARN sign-in is not passwordless yet: run admin.sh passwordless so the Google button shows on the Relay sign-in page');
  const base = PUBLIC || String(realm.attributes?.frontendUrl ?? '').replace(/\/$/, '') || '<your sign-in address>';
  out(`OK redirect URI for Google Cloud console: ${base}/realms/${REALM}/broker/google/endpoint`);
}

try {
  if (!['passwordless', 'passwordless-undo', 'google-signin'].includes(cmd)) throw new Refused('USAGE', 'usage: realm-admin.mjs passwordless|passwordless-undo|google-signin');
  const [user, password, otp, gId, gSecret] = await readSecrets();
  await signIn(user, password, otp);
  if (cmd === 'passwordless') await passwordless();
  else if (cmd === 'passwordless-undo') await undo();
  else await googleSignin(gId?.trim(), gSecret);
} catch (e) {
  if (e instanceof Refused) { out(`ERR ${e.code} ${e.message}`); process.exit(2); }
  out(`ERR ${e.exitCode === 3 ? 'AUTH' : 'FAILED'} ${e.message}`);
  process.exit(e.exitCode ?? 1);
}

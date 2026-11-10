// D34 evidence: screenshots of the passwordless sign-in journey against the running local stack (web :3000, Keycloak :5556,
// Mailpit :8025). Light theme, deviceScaleFactor 2, 1440 and 390 wide → evidence/auth/.
//   node scripts/auth-shots.mjs
// For the sign-in page shots the local realm's Google provider is switched ON with placeholder credentials (so the button
// renders exactly as it will once `admin.sh google-signin` has run) and switched back OFF afterwards. Local only.
import { createRequire } from 'node:module';
import { createHmac } from 'node:crypto';
import { mkdirSync } from 'node:fs';

const require = createRequire(new URL('../package.json', import.meta.url));
const { chromium } = require('@playwright/test');
const APP = 'http://localhost:3000';
const KC = 'http://localhost:5556';
const MAIL = 'http://localhost:8025';
const OUT = 'evidence/auth';
mkdirSync(OUT, { recursive: true });

async function adminToken() {
  const r = await fetch(`${KC}/realms/master/protocol/openid-connect/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'password', client_id: 'admin-cli', username: 'admin', password: 'socialite-kc-admin-local-only' }) });
  return (await r.json()).access_token;
}
async function setGoogle(enabled) {
  const t = await adminToken();
  const h = { authorization: `Bearer ${t}`, 'content-type': 'application/json' };
  const cur = await (await fetch(`${KC}/admin/realms/social-lite/identity-provider/instances/google`, { headers: h })).json();
  await fetch(`${KC}/admin/realms/social-lite/identity-provider/instances/google`, { method: 'PUT', headers: h, body: JSON.stringify({ ...cur, enabled }) });
}
async function latestCode(email, since) {
  for (let i = 0; i < 50; i++) {
    const l = await (await fetch(`${MAIL}/api/v1/search?query=${encodeURIComponent(`to:"${email}" subject:"sign-in code"`)}&limit=5`)).json();
    const m = l.messages.filter((x) => Date.parse(x.Created) >= since - 3000).sort((a, b) => Date.parse(b.Created) - Date.parse(a.Created))[0];
    if (m) return { id: m.ID, code: /(\d{6})/.exec(m.Subject)[1] };
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error('no email');
}
function totp(secret) {
  const c = Buffer.alloc(8); c.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const h = createHmac('sha1', Buffer.from(secret, 'utf8')).update(c).digest(); const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

const browser = await chromium.launch();
try {
  await setGoogle(true);
  for (const [w, h, tag] of [[1440, 900, '1440'], [390, 844, '390']]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, colorScheme: 'light' });
    const page = await ctx.newPage();
    // 1. Sign-in page (Google · or · email)
    await page.goto(`${APP}/login`);
    await page.waitForURL(/localhost:5556/);
    await page.locator('#social-google').waitFor();
    await page.screenshot({ path: `${OUT}/01-sign-in-${tag}.png`, fullPage: true });
    // 2. Sign-up mode (marketing handoff)
    // Separate browser context: a second sign-in in the same browser replaces the first one's login-binding cookie.
    const ctx2 = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, colorScheme: 'light' });
    const p2 = await ctx2.newPage();
    await p2.goto(`${APP}/login?returnTo=${encodeURIComponent('/signup/workspace?plan=professional')}`);
    await p2.waitForURL(/localhost:5556/);
    await p2.getByRole('heading', { name: 'Create your Relay account' }).waitFor();
    await p2.screenshot({ path: `${OUT}/02-sign-up-${tag}.png`, fullPage: true });
    await ctx2.close();
    // 3. Check your email
    const email = 'admin@demo.social-lite.test';
    const since = Date.now();
    await page.locator('#username').fill(email);
    await page.locator('#kc-login').click();
    await page.getByRole('heading', { name: 'Check your email' }).waitFor();
    await page.screenshot({ path: `${OUT}/03-check-your-email-${tag}.png`, fullPage: true });
    // 4. The email itself (Mailpit's HTML render)
    const mail = await latestCode(email, since);
    const mp = await ctx.newPage();
    await mp.goto(`${MAIL}/view/${mail.id}.html`);
    await mp.screenshot({ path: `${OUT}/04-email-${tag}.png`, fullPage: true });
    await mp.close();
    // 5. Code entry (a wrong code first: the error state; then the real code typed)
    await page.locator('#code').fill('000000');
    await page.locator('#relay-verify').click();
    await page.locator('#input-error-code').waitFor();
    await page.locator('#code').fill(mail.code);
    await page.screenshot({ path: `${OUT}/05-code-entry-${tag}.png`, fullPage: true });
    await page.locator('#relay-verify').click();
    await page.waitForURL((u) => u.port === '3000' && !u.pathname.startsWith('/api/auth'), { timeout: 45_000 });
    // 6. Two-step step-up prompt (authenticator app code only)
    await page.goto(`${APP}/api/auth/step-up?returnTo=%2Fsecurity`);
    await page.waitForURL(/localhost:5556/);
    await page.locator('#otp').waitFor();
    await page.screenshot({ path: `${OUT}/06-two-step-${tag}.png`, fullPage: true });
    await page.locator('#otp').fill(totp('socialite-demo-totp-admin'));
    await page.locator('#kc-login').click();
    await page.waitForURL(/\/security\?verified=1/, { timeout: 45_000 });
    // 7. Sign out → marketing page
    await page.getByRole('button', { name: /Account menu/ }).first().click();
    await page.getByRole('menuitem', { name: 'Sign out' }).click();
    await page.waitForURL((u) => u.port === '3000' && u.pathname === '/', { timeout: 45_000 });
    await page.waitForLoadState('networkidle').catch(() => undefined);
    await page.screenshot({ path: `${OUT}/07-signed-out-${tag}.png` });
    await ctx.close();
    await new Promise((r) => setTimeout(r, 31_000)); // next TOTP step for the second size
  }
} finally {
  await setGoogle(false);
  await browser.close();
}
console.log('screenshots in', OUT);

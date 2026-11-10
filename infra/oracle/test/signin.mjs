// Kit test only: signs in to a locally running production-mode Relay through its production-mode Keycloak.
// Hostnames are mapped to 127.0.0.1 inside Chromium; the local Caddy CA is not trusted, so certificate errors are
// ignored for this throwaway test stack only.
// D34 passwordless: types the email, reads the 6-digit code from the test stack's Mailpit and types it.
//   node infra/oracle/test/signin.mjs <app url> <email> <mailpit url> <screenshot dir>
import { chromium } from '@playwright/test';

const [appUrl, email, mailpit, shots] = process.argv.slice(2);
async function code(since) {
  for (let i = 0; i < 60; i++) {
    const r = await fetch(`${mailpit}/api/v1/search?query=${encodeURIComponent(`to:"${email}" subject:"sign-in code"`)}`).then((x) => x.json()).catch(() => ({ messages: [] }));
    const m = (r.messages ?? []).find((x) => Date.parse(x.Created) >= since - 3000);
    if (m) return /(\d{6})/.exec(m.Subject)[1];
    await new Promise((res) => setTimeout(res, 500));
  }
  throw new Error('no sign-in email');
}
const host = new URL(appUrl).hostname;
// Keep any configured egress proxy, but never send the test hostnames through it.
const proxy = process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: `${host},*.${host}` } : undefined;
const browser = await chromium.launch({ proxy, args: [`--host-resolver-rules=MAP ${host} 127.0.0.1, MAP *.${host} 127.0.0.1`] });
const page = await (await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 860 } })).newPage();
const step = (m) => console.log(JSON.stringify({ step: m, url: page.url().replace(/[?#].*/, '') }));
try {
  await page.goto(`${appUrl}/login`); // forwards straight to the sign-in page
  await page.waitForURL((u) => u.hostname.startsWith('auth.'), { timeout: 30_000 });
  step('keycloak sign-in page');
  if (shots) await page.screenshot({ path: `${shots}/keycloak-login.png` });
  const since = Date.now();
  await page.fill('input[name=username]', email);
  await page.click('#kc-login');
  await page.waitForSelector('input[name=code]', { timeout: 30_000 });
  step('check your email');
  await page.fill('input[name=code]', await code(since));
  await page.click('#relay-verify');
  await page.waitForURL((u) => u.hostname === host, { timeout: 30_000 });
  await page.waitForLoadState('networkidle');
  step('back in Relay');
  if (shots) await page.screenshot({ path: `${shots}/after-signin.png` });
  const session = await page.evaluate(async () => { const r = await fetch('/api/session'); return { status: r.status, body: await r.json().catch(() => null) }; });
  console.log(JSON.stringify({ session_status: session.status, signed_in_as: session.body?.user?.email ?? session.body?.email ?? null }));
  if (session.status !== 200) process.exitCode = 1;
} catch (err) {
  step(`FAILED: ${err.message.split('\n')[0]}`);
  if (shots) await page.screenshot({ path: `${shots}/failure.png` }).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
}

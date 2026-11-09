// Kit test only: signs in to a locally running production-mode Relay through its production-mode Keycloak.
// Hostnames are mapped to 127.0.0.1 inside Chromium; the local Caddy CA is not trusted, so certificate errors are
// ignored for this throwaway test stack only.
//   node infra/oracle/test/signin.mjs <app url> <email> <password file> <screenshot dir>
import { readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const [appUrl, email, pwFile, shots] = process.argv.slice(2);
const password = readFileSync(pwFile, 'utf8').trim();
const host = new URL(appUrl).hostname;
// Keep any configured egress proxy, but never send the test hostnames through it.
const proxy = process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: `${host},*.${host}` } : undefined;
const browser = await chromium.launch({ proxy, args: [`--host-resolver-rules=MAP ${host} 127.0.0.1, MAP *.${host} 127.0.0.1`] });
const page = await (await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 860 } })).newPage();
const step = (m) => console.log(JSON.stringify({ step: m, url: page.url().replace(/[?#].*/, '') }));
try {
  await page.goto(`${appUrl}/login`);
  step('login page');
  const start = page.locator('a[href*="/api/auth/login"], button:has-text("Sign in"), a:has-text("Sign in"), button:has-text("Continue")').first();
  await start.click();
  await page.waitForURL((u) => u.hostname.startsWith('auth.'), { timeout: 30_000 });
  step('keycloak login form');
  if (shots) await page.screenshot({ path: `${shots}/keycloak-login.png` });
  await page.fill('input[name=username]', email);
  await page.fill('input[name=password]', password);
  await page.click('#kc-login, [type=submit]');
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

// Kit test only: the Keycloak admin console works on the loopback port (what an SSH tunnel gives the operator).
//   node infra/oracle/test/admin-login.mjs <http://localhost:PORT> <password file>
import { readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const [base, pwFile] = process.argv.slice(2);
const proxy = process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: 'localhost,127.0.0.1' } : undefined;
const browser = await chromium.launch({ proxy });
const page = await browser.newPage();
try {
  await page.goto(`${base}/admin/`);
  await page.waitForSelector('input[name=username]', { timeout: 60_000 });
  await page.fill('input[name=username]', 'bootstrap-admin');
  await page.fill('input[name=password]', readFileSync(pwFile, 'utf8').trim());
  await page.click('#kc-login, [type=submit]');
  await page.waitForURL(/\/admin\/master\/console\//, { timeout: 60_000 });
  await page.waitForLoadState('networkidle');
  console.log(JSON.stringify({ admin_console: 'ok', host: new URL(page.url()).host }));
} catch (err) {
  console.log(JSON.stringify({ admin_console: 'failed', url: page.url().replace(/[?#].*/, ''), err: err.message.split('\n')[0] }));
  process.exitCode = 1;
} finally {
  await browser.close();
}

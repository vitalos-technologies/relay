// Local development only: print the current one-time code for a privileged demo identity of the local Keycloak
// realm (infra/keycloak/social-lite-realm.json), so a person can sign in without setting up an authenticator app.
// Usage: npx tsx scripts/demo-totp.ts owner        (owner | admin | publisher | other-owner)
// These secrets exist only in the disposable local realm; real accounts enrol their own factor at the IdP.
import { createHmac } from 'node:crypto';

const SECRETS: Record<string, { email: string; secret: string }> = {
  owner: { email: 'owner@demo.social-lite.test', secret: 'socialite-demo-totp-owner' },
  admin: { email: 'admin@demo.social-lite.test', secret: 'socialite-demo-totp-admin' },
  publisher: { email: 'publisher@demo.social-lite.test', secret: 'socialite-demo-totp-publisher' },
  'other-owner': { email: 'owner@other.social-lite.test', secret: 'socialite-demo-totp-other-owner' },
};

function totp(key: Buffer, at = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)));
  const h = createHmac('sha1', key).update(counter).digest();
  const o = h[h.length - 1]! & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

const who = (process.argv[2] ?? 'owner').replace(/@.*$/, '');
const entry = SECRETS[who];
if (!entry) {
  console.error(`Unknown demo identity "${who}". Use one of: ${Object.keys(SECRETS).join(', ')}`);
  process.exit(1);
}
const left = 30 - Math.floor(Date.now() / 1000) % 30;
console.log(`${entry.email}: ${totp(Buffer.from(entry.secret, 'utf8'))} (valid ~${left}s)`);

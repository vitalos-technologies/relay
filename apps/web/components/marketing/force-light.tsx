// Light only (user request 2026-11-10): the marketing page and the signed-out Help Centre always render the light theme,
// whatever prefers-color-scheme or the app's saved theme says. The inline script sets it before first paint; the client
// part restores the visitor's own app theme if the page is left by client-side navigation (shared root layout).
import { headers } from 'next/headers';
import { RestoreAppTheme } from './restore-app-theme';

const BOOT = "document.documentElement.setAttribute('data-theme','light')";

export async function ForceLightTheme() {
  // Same per-request CSP nonce as the root layout's theme script (without it the browser blocks this inline script).
  const nonce = (await headers()).get('x-nonce') ?? undefined;
  return <><script nonce={nonce} dangerouslySetInnerHTML={{ __html: BOOT }} /><RestoreAppTheme /></>;
}

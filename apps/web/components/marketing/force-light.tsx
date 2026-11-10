// Light only (user request 2026-11-10): the marketing page and the signed-out Help Centre always render the light theme,
// whatever prefers-color-scheme or the app's saved theme says. The inline script sets it before first paint; the client
// part restores the visitor's own app theme if the page is left by client-side navigation (shared root layout).
import { RestoreAppTheme } from './restore-app-theme';

const BOOT = "document.documentElement.setAttribute('data-theme','light')";

export function ForceLightTheme() {
  return <><script dangerouslySetInnerHTML={{ __html: BOOT }} /><RestoreAppTheme /></>;
}

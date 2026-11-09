// Help Centre (HC) server helpers: who is reading (audiences resolved from the session + database, never the browser),
// and where the content's static files live. Server-only.
import 'server-only';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { cache } from 'react';
import { headers } from 'next/headers';
import { notFound, permanentRedirect, redirect } from 'next/navigation';
import { helpLibrary, helpPathDecision } from '@social-lite/services/help/library';
import { log } from '@social-lite/services';
import { SIGNED_OUT_VIEWER, helpViewerFor, type HelpViewer } from '@social-lite/services/help/access';
import { currentSession } from '@/lib/api';

/** One resolution per request. Any failure reads as signed out (public articles only) — fails closed. */
export const getHelpViewer = cache(async (): Promise<HelpViewer> => {
  try {
    return await helpViewerFor(await currentSession());
  } catch (err) {
    log.warn('help_viewer_failed', { err: err as Error });
    return SIGNED_OUT_VIEWER;
  }
});

/** apps/web/public (cwd is apps/web under `next start`; the repo root in tests/scripts). */
export function webPublicDir(): string {
  for (const p of [join(process.cwd(), 'public'), join(process.cwd(), 'apps', 'web', 'public')]) if (existsSync(join(p, 'help'))) return p;
  return join(process.cwd(), 'public');
}

/** The request path, as set by proxy.ts (null when the proxy didn't run, e.g. router prefetches). */
export async function requestPathname(): Promise<string | null> {
  return (await headers()).get('x-relay-pathname');
}

/**
 * Called by the (help) layout before it renders the shell (M18). Signed-in pages render inside a client shell that
 * streams first, so a page-level notFound() came too late to change the HTTP status (200). Deciding here gives a real
 * 404 (or redirect status). The pages keep their own checks; this only moves the status decision earlier.
 */
export async function enforceHelpPath(viewer: HelpViewer): Promise<void> {
  const path = await requestPathname();
  if (!path) return;
  const d = helpPathDecision(helpLibrary(), path, viewer);
  if (!d || d.kind === 'ok') return;
  if (d.kind === 'not_found') notFound();
  if (d.permanent) permanentRedirect(d.href);
  redirect(d.href);
}

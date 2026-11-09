// GET /api/help/bundle — offline copy of the Help Centre (HC): static HTML (zip) of the articles this signed-in reader
// may open (their audiences, resolved on the server). Same builder as scripts/docs-bundle.mjs. Runbooks never included.
import { helpLibrary } from '@social-lite/services/help/library';
import { buildHelpBundle, bundleFileName, zipFiles } from '@social-lite/services/help/bundle';
import { HELP_PRODUCT_VERSION } from '@social-lite/services/help/schema';
import { route } from '@/lib/api';
import { getHelpViewer, webPublicDir } from '@/lib/help-server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** One zip per audience set for the loaded content (production loads content once). */
const cache = new Map<string, { at: number; zip: Buffer }>();

export const GET = route(async () => {
  const viewer = await getHelpViewer();
  const lib = helpLibrary();
  const key = `${viewer.audiences.join(',')}@${lib.loadedAt}`;
  let hit = cache.get(key);
  if (!hit) {
    hit = { at: Date.now(), zip: zipFiles(buildHelpBundle(lib, { audiences: viewer.audiences, publicDir: webPublicDir() })) };
    for (const k of cache.keys()) if (!k.endsWith(`@${lib.loadedAt}`)) cache.delete(k); // drop bundles of older content
    cache.set(key, hit);
  }
  return new Response(new Uint8Array(hit.zip), {
    headers: {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="${bundleFileName(HELP_PRODUCT_VERSION)}"`,
      'cache-control': 'private, no-store',
    },
  });
}, { workspace: false });

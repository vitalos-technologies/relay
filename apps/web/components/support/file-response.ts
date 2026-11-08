// Server helper: stream a validated support attachment. nosniff + a sandboxing CSP; images inline, everything else as a download.
import 'server-only';

export function fileResponse(f: { bytes: Buffer; mime: string; filename: string; inline: boolean }): Response {
  const name = f.filename.replace(/[^\w.\- ]+/g, '_');
  return new Response(new Uint8Array(f.bytes), {
    headers: {
      'content-type': f.mime,
      'content-length': String(f.bytes.length),
      'content-disposition': `${f.inline ? 'inline' : 'attachment'}; filename="${name}"`,
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'cache-control': 'private, no-store',
    },
  });
}

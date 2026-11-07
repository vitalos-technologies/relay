// Content-Security-Policy for HTML pages (nonce-based, 'strict-dynamic'). Pure so it can be unit tested.
//  - scripts: only Next's own bundles/inline scripts carrying the per-request nonce (+ 'unsafe-eval' in dev for React)
//  - connect/img/media: same origin + the object-storage origin (presigned POST uploads and previews)
//  - no framing (frame-ancestors 'none'), no plugins, no <base> hijack, forms post only to this origin
/** V3 Content Hub: Google Picker iframe + Google Identity token client + Drive API calls from the browser (no other Google origins). */
export const GOOGLE_PICKER_ORIGINS = {
  frame: ['https://docs.google.com', 'https://accounts.google.com', 'https://content.googleapis.com'],
  connect: ['https://www.googleapis.com', 'https://content.googleapis.com', 'https://accounts.google.com'],
  img: ['https://*.googleusercontent.com', 'https://ssl.gstatic.com', 'https://drive-thirdparty.googleusercontent.com'],
};

export function buildCsp(nonce: string, opts: { dev: boolean; storageOrigins: string[]; production: boolean; googlePicker?: boolean }): string {
  const gp = opts.googlePicker ? GOOGLE_PICKER_ORIGINS : { frame: [], connect: [], img: [] };
  const storage = [...new Set(opts.storageOrigins.filter(Boolean))].join(' ');
  const directives: Array<[string, string]> = [
    ['default-src', "'self'"],
    ['script-src', `'self' 'nonce-${nonce}' 'strict-dynamic'${opts.dev ? " 'unsafe-eval'" : ''}`],
    // React/Radix set style attributes at runtime; style injection is not script execution.
    ['style-src', "'self' 'unsafe-inline'"],
    ['img-src', [`'self' blob: data:`, storage, ...gp.img].filter(Boolean).join(' ')],
    ['media-src', `'self' blob: ${storage}`.trim()],
    ['font-src', "'self' data:"],
    ['connect-src', ["'self'", storage, ...gp.connect, opts.dev ? 'ws: wss:' : ''].filter(Boolean).join(' ')],
    ['worker-src', "'self' blob:"],
    ['frame-src', gp.frame.length ? gp.frame.join(' ') : "'none'"],
    ['object-src', "'none'"],
    ['base-uri', "'self'"],
    ['form-action', "'self'"],
    ['frame-ancestors', "'none'"],
    ['manifest-src', "'self'"],
  ];
  if (opts.production) directives.push(['upgrade-insecure-requests', '']);
  return directives.map(([k, v]) => (v ? `${k} ${v}` : k)).join('; ');
}

export function originOf(url: string | undefined): string {
  if (!url) return '';
  try { return new URL(url).origin; } catch { return ''; }
}

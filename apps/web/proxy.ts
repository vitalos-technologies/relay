// Next.js Proxy: per-request CSP nonce for HTML pages (Next applies the nonce to its scripts during SSR).
// API routes get their own strict headers from next.config.ts.
import { NextResponse, type NextRequest } from 'next/server';
import { buildCsp, originOf } from './lib/csp';

export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const csp = buildCsp(nonce, {
    dev: process.env.NODE_ENV === 'development',
    production: process.env.APP_ENV === 'production',
    storageOrigins: [originOf(process.env.S3_PUBLIC_ENDPOINT), originOf(process.env.S3_ENDPOINT)],
    // V3 Content Hub: Google Picker (set CONTENT_HUB_GOOGLE_PICKER=false to keep frame-src 'none').
    googlePicker: process.env.CONTENT_HUB_GOOGLE_PICKER !== 'false',
  });
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  // Lets server layouts make routing decisions (e.g. a Help Centre 404) before the response starts streaming.
  requestHeaders.set('x-relay-pathname', request.nextUrl.pathname);
  requestHeaders.set('Content-Security-Policy', csp);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', csp);
  return response;
}

export const config = {
  matcher: [
    {
      source: '/((?!api|_next/static|_next/image|favicon.ico|icon|apple-icon).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};

import type { NextConfig } from 'next';

// Page CSP (nonce-based) is set per request in proxy.ts. These apply to every response.
const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), hid=(), bluetooth=(), browsing-topics=()' },
  // HSTS only where the app is served over HTTPS (production); never on local http.
  ...(process.env.APP_ENV === 'production' ? [{ key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' }] : []),
];
// JSON API responses never render: forbid everything.
const apiHeaders = [{ key: 'Content-Security-Policy', value: "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" }];

const nextConfig: NextConfig = {
  output: 'standalone',
  outputFileTracingRoot: new URL('../../', import.meta.url).pathname,
  transpilePackages: ['@social-lite/core', '@social-lite/db', '@social-lite/providers', '@social-lite/services'],
  serverExternalPackages: ['sharp', 'pg', 'pg-boss', 'nodemailer', 'openid-client'],
  poweredByHeader: false,
  typedRoutes: false,
  // Workspace packages use ESM ".js" import suffixes that point at ".ts" sources.
  webpack(config) {
    config.resolve.extensionAlias = { '.js': ['.ts', '.tsx', '.js'], '.mjs': ['.mts', '.mjs'] };
    return config;
  },
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }, { source: '/api/:path*', headers: apiHeaders }];
  },
};

export default nextConfig;

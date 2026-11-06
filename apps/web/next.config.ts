import type { NextConfig } from 'next';

const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
];

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
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;

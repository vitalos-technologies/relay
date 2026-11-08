import './globals.css';
import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { headers } from 'next/headers';
import localFont from 'next/font/local';
import { GeistMono } from 'geist/font/mono';
import { BRAND } from '@social-lite/core';

// Inter (brand typeface), self-hosted variable font — no network fetch at build time.
const inter = localFont({
  src: [
    { path: '../node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2', weight: '100 900', style: 'normal' },
    { path: '../node_modules/@fontsource-variable/inter/files/inter-latin-ext-wght-normal.woff2', weight: '100 900', style: 'normal' },
  ],
  variable: '--font-inter',
  display: 'swap',
});

export const metadata: Metadata = {
  title: { default: BRAND.name, template: `%s · ${BRAND.name}` },
  description: BRAND.tagline,
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: dark)', color: '#0E1013' },
    { media: '(prefers-color-scheme: light)', color: '#F5F6F7' },
  ],
};

// Applies the saved theme choice before first paint (no flash). Static string, no user input.
const THEME_BOOT = `try{var t=localStorage.getItem('sl-theme');if(t==='light'||t==='dark')document.documentElement.setAttribute('data-theme',t)}catch(e){}`;

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Per-request CSP nonce from proxy.ts (pages are rendered dynamically so every response gets a fresh nonce).
  const nonce = (await headers()).get('x-nonce') ?? undefined;
  return (
    <html lang="en-GB" className={`${inter.variable} ${GeistMono.variable}`} suppressHydrationWarning>
      <head>
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
      </head>
      <body className="bg-bg text-fg antialiased">{children}</body>
    </html>
  );
}

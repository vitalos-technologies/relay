import './globals.css';
import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { GeistSans } from 'geist/font/sans';
import { GeistMono } from 'geist/font/mono';

export const metadata: Metadata = {
  title: { default: 'Social Lite', template: '%s · Social Lite' },
  description: 'Plan, approve and publish to Instagram, Facebook, Telegram and X.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: dark)', color: '#0D0E10' },
    { media: '(prefers-color-scheme: light)', color: '#F5F6F7' },
  ],
};

// Applies the saved theme choice before first paint (no flash). Static string, no user input.
const THEME_BOOT = `try{var t=localStorage.getItem('sl-theme');if(t==='light'||t==='dark')document.documentElement.setAttribute('data-theme',t)}catch(e){}`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en-GB" className={`${GeistSans.variable} ${GeistMono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
      </head>
      <body className="bg-bg text-fg antialiased">{children}</body>
    </html>
  );
}

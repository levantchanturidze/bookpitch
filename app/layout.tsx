import type { Metadata, Viewport } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';
import ServiceWorkerRegistrar from '@/components/pwa/ServiceWorkerRegistrar';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  title: 'Bookpitch',
  description: 'Multi-tenant clinic & salon scheduling platform.',
  applicationName: 'Bookpitch',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'default',
    title: 'Bookpitch',
  },
};

export const viewport: Viewport = {
  themeColor: '#0d9488',
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // P14-001: this said `?? 'ka'`, and LOCALE is not set in production, so every
  // page declared Georgian while rendering English. Not a cosmetic slip — WCAG
  // 2.2 SC 3.1.1 (Language of Page, Level A): a screen reader reads the whole
  // UI with Georgian phonetics, and browsers offer to "translate" text already
  // in the reader's language.
  //
  // The honest default is the language the app actually ships: all 87
  // component/page files render hardcoded English, and lib/i18n.ts has zero
  // consumers. LOCALE still overrides, so setting LOCALE=ka once the UI is
  // genuinely translated needs no code change.
  return (
    <html
      lang={process.env.LOCALE ?? 'en'}
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col">
        {/* Skip link — first focusable element. Keyboard users tab once
            and jump straight past the header into the main region. */}
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-50 focus:rounded focus:bg-slate-900 focus:px-3 focus:py-2 focus:text-sm focus:text-white"
        >
          Skip to main content
        </a>
        {children}
        <ServiceWorkerRegistrar />
      </body>
    </html>
  );
}

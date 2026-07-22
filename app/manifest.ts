import type { MetadataRoute } from 'next';

// Web App Manifest — makes Bookpitch installable as a standalone app on
// mobile + desktop (Chrome, Edge, Safari on iOS 16+, etc.).
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Bookpitch',
    short_name: 'Bookpitch',
    description: 'Multi-tenant clinic & salon scheduling.',
    start_url: '/scheduler',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#F8FAFC',
    theme_color: '#0d9488',
    // Next auto-registers the sibling icon.tsx / apple-icon.tsx routes; we
    // duplicate the 192px entry here so PWA installers explicitly find it.
    icons: [
      { src: '/icon', type: 'image/png', sizes: '192x192' },
      { src: '/icon-large', type: 'image/png', sizes: '512x512' },
      {
        src: '/icon-large',
        type: 'image/png',
        sizes: '512x512',
        purpose: 'maskable',
      },
    ],
    categories: ['medical', 'productivity', 'business'],
  };
}

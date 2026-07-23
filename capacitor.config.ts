// -----------------------------------------------------------------------------
// Capacitor wrapper for iOS + Android. The mobile shell just loads the
// deployed Next.js app in a WebView — the PWA already does the heavy
// lifting (offline shell + web push). This gets us App Store presence
// without shipping a separate React Native codebase.
//
// One-time setup on a fresh checkout:
//   npm install --save @capacitor/core @capacitor/cli @capacitor/ios @capacitor/android
//   npx cap add ios
//   npx cap add android
//   npx cap sync
//
// Deploy iteration:
//   npx cap sync   (after any web asset change)
//   npx cap open ios | android
// -----------------------------------------------------------------------------

// The CapacitorConfig type ships with @capacitor/cli. We deliberately
// avoid depending on it here so `npm install` isn't a launch prereq —
// the runtime shape is just a JSON object the Capacitor CLI reads.
const config = {
  appId: 'ge.bookpitch.app',
  appName: 'Bookpitch',
  // No local webDir — the shell loads the deployed origin. Set
  // CAPACITOR_SERVER_URL at build time in CI to point at your Vercel
  // production URL (e.g. https://bookpitch.ge).
  webDir: 'public',
  server: {
    url: process.env.CAPACITOR_SERVER_URL ?? 'https://bookpitch.ge',
    // iOS 14+ requires this for arbitrary HTTPS loads even though it's
    // the default; being explicit avoids "why won't it load" during
    // localhost debugging.
    androidScheme: 'https' as const,
    // Localhost debug: run `npx next dev --hostname 0.0.0.0` and set
    // CAPACITOR_SERVER_URL=http://<your-lan-ip>:3000 for hot reload.
    cleartext: process.env.NODE_ENV !== 'production',
  },
  ios: {
    contentInset: 'always' as const,
    backgroundColor: '#F8FAFC',
  },
  android: {
    backgroundColor: '#F8FAFC',
  },
};

export default config;

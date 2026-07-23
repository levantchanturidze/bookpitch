# Mobile shell — Capacitor wrapper + Web Push

The MVP mobile story is **PWA + Capacitor wrapper**, not a separate React
Native codebase. That gets us App Store / Play Store presence and the
"install to home screen with push" UX with the same server-rendered pages
as the desktop app.

## Web Push

Enabled by default in the app once VAPID keys land in env:

```bash
npx web-push generate-vapid-keys --json
```

Output:

```json
{ "publicKey": "BM…", "privateKey": "abc…" }
```

Set in Vercel:

```
VAPID_PUBLIC_KEY=BM…
VAPID_PRIVATE_KEY=abc…
NEXT_PUBLIC_VAPID_PUBLIC_KEY=BM…   # same as VAPID_PUBLIC_KEY
VAPID_SUBJECT=mailto:ops@bookpitch.ge
```

Client code calls `subscribeToPush()` from `lib/push-client.ts` after
a "Enable notifications" click. Server code fans out with `pushToUser(userId,
{title, body, url?})` from `lib/push.ts`.

Payload rules:

- **Never** include patient names, phone, email, DOB, allergies, clinical
  notes, or specific service names. iOS + Android surface the body on
  the lock screen.
- Use counts + generic phrases: "3 new bookings today", "Slot opened",
  "Payment received".

## Capacitor wrapper

The wrapper is a thin WebView shell that loads the deployed origin. No
JavaScript bridge, no native modules — the PWA already handles offline
+ push.

One-time setup on a fresh checkout:

```bash
npm install --save @capacitor/core @capacitor/cli @capacitor/ios @capacitor/android
npx cap add ios
npx cap add android
npx cap sync
```

Iterate:

```bash
# after any web asset change or a server URL bump:
npx cap sync
npx cap open ios       # or `android`
```

Point at a different origin via env:

```bash
CAPACITOR_SERVER_URL=http://192.168.1.42:3000 npx cap sync
```

## What is NOT in the wrapper

- No native camera / geolocation / contacts hooks. Add them later with
  `@capacitor/camera` etc. only when a real feature needs one.
- No native auth (Sign in with Apple). The web sign-in works inside the
  WebView; native auth is a nice-to-have, not a launch blocker.
- No offline write queue for appointments. The service worker only
  caches shell HTML; writes go through the network. Offline booking
  would need a background sync + reconcile layer.

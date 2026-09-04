# ADR 0001 — Mobile scope: PWA-first, no native app

**Status:** Accepted (2026-09) · **Scope:** mobile field experience ·
**Revisit:** per triggers below

## Context

MjengoOS's heaviest users are on phones: fundis checking in, foremen logging
deliveries, diaspora clients reviewing progress. The current mobile story is
real but deliberately thin:

- `src/mobile/` is a phone-first shell — the bottom tab bar is its only
  mobile-ONLY component; everything else is responsive shared code in
  `src/frontend/` (mobile-first Tailwind, stacked-card data tables).
- The app is an **installable PWA**: web app manifest (`display:
  standalone`) + a service worker (`public/sw.js`) serving a precached
  offline shell when the network drops.
- Writes survive offline through a **persisted outbox** (zustand + local
  storage): mutations queue locally and sync on reconnect, deduped by
  outbox id so a lost response can't double-post money.
- Attendance also has a **no-smartphone path** (USSD, kiosk PINs) for crew
  without app access at all.

A native (React Native / Expo) app today would duplicate that stack with no
new capability; the PWA covers the real job-site workflows so far.

## Decision

Ship **PWA-first**. No native app until field crews need native-only
capabilities the web platform cannot deliver.

## Consequences

- One codebase, one CI gate, one deploy; installable home-screen icon +
  offline shell at zero native cost; no app-store review or binary signing.
- Web-bounded device APIs: camera works via file input / `getUserMedia`
  (adequate for evidence photos); background push and background GPS are
  NOT implemented.

## Revisit triggers — go native (Expo) when ANY of these hold

1. Field crews need **offline push** (alerts with the app closed) that web
   push can't deliver reliably on target devices.
2. **Background GPS** becomes a requirement (geofence attendance without
   opening the app).
3. **Camera depth** beyond web capture (background camera-roll upload, AR
   site capture).
4. Crew phones measurably can't run the PWA acceptably.

Until then, mobile improvements land in the responsive shared code.

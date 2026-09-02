# src/mobile/ — the mobile shell

The phone-first experience layer. Today this is the **bottom navigation bar**
(the only genuinely mobile-ONLY component in the codebase); every other mobile
experience is achieved responsively inside the shared `src/frontend/` components
(see "Responsive strategy" below).

## What lives here

```
src/mobile/
  nav/mobile-bottom-nav.tsx   # <768px bottom tab bar + camera quick-action + More sheet
  README.md
```

`nav/mobile-bottom-nav.tsx` (W1-PERM · Doc B §53/§54/§56):

- **≤ 5 primary tabs** for the signed-in role (capped at 4 whenever the camera
  quick-action or the "More" sheet occupies a cell) — taken from the role's tab
  set in `src/shared/permissions.ts`, never empty (unknown roles fail closed to
  Overview).
- **Camera quick-action** — shown only for roles whose tab set includes the AI
  Copilot (§56: never show a button the role cannot use). It navigates to the
  Copilot tab, which owns the actual photo capture → AI analysis flow.
  There is deliberately **no separate camera-capture component** here: capture
  UI lives in the responsive `frontend/mjengo/copilot-tab.tsx` and
  `evidence-tab.tsx` so desktop and mobile share one implementation.
- **"More" sheet** (shadcn Sheet) listing the remaining tabs beyond the primary
  five, with an honest count ("8 of 12 tabs").
- Roving-tabindex keyboard nav (`useTablistKeyboard` from
  `frontend/mjengo/nav/use-tablist.ts`), `role="tablist"` on the container,
  aria-labels on icon-only buttons, bottom safe-area inset, 44px touch targets.
- **Hidden on `md+`** where the desktop top strip in `frontend/mjengo/header.tsx`
  takes over (the client share-link surface keeps the strip at all widths).

## Mobile-first responsive strategy (whole app)

The app is designed mobile-first and every surface is responsive — mobile is
not a separate build:

- `frontend/hooks/use-mobile.ts` (`useIsMobile`) is the width probe
  (< 768px). It is used by shadcn primitives such as `frontend/ui/sidebar.tsx`
  and is available anywhere; it lives under `frontend/hooks/` (not here)
  because it is shared infrastructure, not mobile-only UI.
- Tabs and dialogs render as full-width stacked cards on small screens;
  long tables scroll inside their own container (`max-h-96 overflow-y-auto`
  + the app's thin custom scrollbar) instead of stretching the page.
- `frontend/mjengo/uikit/data-table.tsx` switches from a desktop table to
  stacked `label: value` cards below `md` — the canonical responsive pattern
  for data-heavy tabs.
- i18n short labels (`tab-meta.ts` `shortLabel`) are what the bottom bar
  renders, so translated locales stay narrow on phones.

## Finding mobile-specific vs responsive-shared code

- **Mobile-only**: anything in `src/mobile/` (currently just the bottom nav).
- **Responsive-shared**: everything in `src/frontend/mjengo/**` — check for
  `md:` / `lg:` Tailwind breakpoints, `useIsMobile()`, and the DataTable
  stacked-card fallback. If a future component can only ever exist on phones
  (e.g. a native-camera capture screen), it belongs in this folder; otherwise
  extend the shared responsive component.

## Imports

This folder imports from `@/frontend/ui`, `@/frontend/mjengo/nav/*`,
`@/frontend/mjengo/app` (type-only), `@/frontend/i18n`, and `@/shared/permissions`.
Nothing under `src/backend/` may ever be imported here (value imports of server
code would leak server modules into the client bundle).

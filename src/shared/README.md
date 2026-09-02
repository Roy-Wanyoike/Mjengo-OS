# src/shared/ — isomorphic contracts

Code that is **safe to import from both server and client** and exists so the
two sides share ONE source of truth instead of drifting copies:

```
src/shared/
  permissions.ts       # role → tab matrix (client UX mirror of guard.ts)
  client-actions.ts    # the CLIENT_ACTIONS allowlist (route + store share it)
```

## permissions.ts — the role matrix

- `ALL_TABS` (canonical tab universe + order), `ROLE_TABS` / `tabsForRole()`
  (which tabs each role sees), `OWNER_ROLES`, `KNOWN_ROLES`, `ROLE_LABELS`,
  `landingForRole()`, `usePermissions()` (reads the next-auth session).
- **Mirror, not enforcement**: server truth is `src/backend/lib/guard.ts`
  (per-route `withGuard` allowlists). Keep the two in sync in the same commit;
  unknown roles fail closed everywhere (one safe tab — Overview).
- Note: this file currently carries `'use client'` + `useSession` because
  every consumer so far is a client component (`header`, `app`,
  `command-palette`, `mobile/nav/mobile-bottom-nav`, audit/settings/overview
  tabs). The pure constants (`ALL_TABS`, `ROLE_TABS`, `ROLE_LABELS`, …) are
  isomorphic and server-importable; only the `usePermissions` hook needs a
  session context.

## client-actions.ts — the client-role action allowlist

`CLIENT_ACTIONS`: the actions a client-role user (and the share-link client
surface) may perform. Imported by BOTH sides of the wire — the server routes
`src/app/api/actions` + `src/app/api/sync` validate against it, and
`src/frontend/hooks/use-mjengo.ts` re-exports it for the client store. Type-only
dependency on `@/backend/lib/mjengo` (`ActionType`), so nothing server-side
ever reaches a client bundle.

## Rules for adding files here

A file belongs in `shared/` only if BOTH server and client code import it (or
it is a pure constant contract with zero runtime dependencies on either side).
Client-only helpers go to `src/frontend/`, server-only code to `src/backend/`.

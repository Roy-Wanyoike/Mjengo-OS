/**
 * Build-time gates for dev/QA-only UI affordances (issue #136 / audit FE-7).
 *
 * Next.js inlines `process.env.NODE_ENV` into client bundles at BUILD time
 * (webpack DefinePlugin — next/dist/build/define-env.js maps it to
 * 'development' under `next dev`, 'production' for every `next build`), so a
 * module-scope comparison is decided when the bundle is produced, never in
 * the browser: a production build folds the constant to `false` and the
 * minifier dead-code-eliminates everything it gates. This is the
 * SHOW_DEMO_QUICKFILL pattern from the login screen (FE-1/MD-1, audit wave
 * 2), promoted into a shared module so the gate itself is importable —
 * tests/unit/header-sim-toggle-gate.test.ts re-imports it under a mutated
 * NODE_ENV to pin the production fold BEHAVIORALLY (the
 * whatsapp-route.test.ts WEBHOOK_OPEN_POSTURE matrix pattern), not just as a
 * source string.
 *
 * Deliberately NO runtime/demo override. Unlike the webhook open posture
 * (#156 — a server route reading process.env per request), a client bundle
 * cannot read new env at runtime, so an "opt back in" flag would have to be
 * a NEXT_PUBLIC_ build flag — and Next only inlines NEXT_PUBLIC vars that
 * are SET at build time (unset ones survive as runtime lookups against the
 * empty browser process shim), which would defeat the dead-code elimination
 * that keeps the affordance's markup out of shipped production code. The
 * repo has no NODE_ENV=production demo deployment (the demo story is the
 * seeded dev server — `bun run dev` + `bun run seed`; the e2e suite drives
 * that same dev server), so the honest gate is the runtime distinction
 * itself: dev/test keep the affordance, production builds do not ship it.
 * If a production-mode demo deployment ever needs it back, extend the
 * constant with `|| process.env.NEXT_PUBLIC_CONNECTIVITY_SIM === '1'` (set
 * at BUILD time) — one line plus .env.example documentation, and accept the
 * loss of DCE for that demo build.
 */

/**
 * FE-7 (#136): the owner header's online/offline SIMULATION pill.
 *
 * The store's `online` flag is real state (app.tsx mirrors
 * navigator.onLine + the window online/offline events into it), and the
 * store's `setOnline` stays fully functional in EVERY runtime — it is the
 * browser-event path and the unit suites' way to exercise offline flows
 * (outbox-auto-retry / supplier-outbox / outbox-auth-drain all drive it
 * directly on the store). This gate removes only the manual OVERRIDE
 * control from production builds, where a user flipping it would queue real
 * outbox items for no reason and blur "really offline" vs "simulated
 * offline" — the amber offline banner and the outbox panel keep surfacing
 * the real state in production.
 */
export const SHOW_CONNECTIVITY_SIM = process.env.NODE_ENV !== 'production'

/**
 * Offline session-gate decision (issue #78 / audit FE-1) — PURE, unit-tested.
 *
 * app.tsx wires this into its auth gate: next-auth's session check needs the
 * network, so a PWA reopened offline used to sit on the boot skeleton (fetch
 * hanging on a dead radio) or bounce to the login screen (fetch failing fast
 * to 'unauthenticated') — while the user's data + outbox sat right there in
 * the persisted `mjengo-os-store`. This decision is the honest short-circuit:
 * when the gate is provably stuck AND persisted data exists, boot the app
 * shell from the cached store instead ("continue offline").
 *
 * Honesty rules (deliberate, mirrored in app.tsx):
 *   · it never PRETENDS to be online — the amber offline banner + outbox
 *     queueing behavior are driven by the store's `online` flag, unchanged;
 *   · the session role is UNKNOWN offline (next-auth keeps no client copy),
 *     so the permission system fail-closes to the Overview tab — no guessing;
 *   · when the session later resolves ('authenticated') or the browser
 *     reports connectivity again, the normal gates take over.
 */

/** How long the auth gate may show the boot skeleton before "continue offline". */
export const AUTH_LOADING_TIMEOUT_MS = 3500

/** The next-auth useSession status values the decision cares about. */
export type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated'

export interface OfflineBootInput {
  status: AuthStatus
  /**
   * True once the gate has sat in `status === 'loading'` for
   * AUTH_LOADING_TIMEOUT_MS (lie-fi: the request hangs). app.tsx resets it
   * the moment status leaves 'loading'.
   */
  authTimedOut: boolean
  /** The browser's real connectivity (the store's `online`, re-synced on mount). */
  online: boolean
  /** Persisted project data exists — the cached store has something to show. */
  hasData: boolean
}

/**
 * Should the app boot into the offline ("continue offline") path? Armed when
 * persisted data exists AND the auth gate is stuck — either the session fetch
 * hung past the timeout, or it resolved 'unauthenticated' while the browser
 * is actually offline (offline, the fetch rejects fast into a false
 * 'unauthenticated' even for a signed-in user with a valid cookie). Disarmed
 * by anything else: a resolved session, a signed-out-but-online user (login
 * screen is the honest gate), or no persisted data (nothing to show offline).
 */
export function shouldOfflineBoot(input: OfflineBootInput): boolean {
  const gateStuck =
    input.authTimedOut || (input.status === 'unauthenticated' && !input.online)
  return input.hasData && gateStuck
}

// Internal-error detection — the S-SEC redaction rule, extracted as a LEAF.
//
// isInternalError decides what error detail may cross a trust boundary:
// guard.ts's safeErrorMessage uses it to keep Prisma/framework internals out
// of client response bodies, and lib/errors/sink.ts (issue #202) uses the
// SAME rule to keep them — and their stacks — out of the external error
// sink's payloads. One rule, two boundaries, one implementation.
//
// WHY A SEPARATE FILE (issue #202): the rule predates this module in
// guard.ts, and guard.ts remains its historical public home (it re-exports
// this function, so every existing importer keeps working). But guard.ts is
// the auth module — it pulls next/server and next-auth/jwt into anything
// that imports it. The error sink is imported by the jobs drain and
// route-kit, i.e. by module graphs that tests mock guard.ts inside; giving
// the sink a LEAF import (this file imports NOTHING) keeps the redaction
// rule canonical without dragging the session machinery into the capture
// seam's graph.
//
// The rules themselves are UNCHANGED from guard.ts (moved verbatim):
//   · Prisma client errors — class name `Prisma*`, code `P####`, or the
//     "`` invocation in" validation banner — leak absolute build paths,
//     table shapes and the dev-server chunk map;
//   · multi-line messages are internal too — domain errors thrown by the
//     appliers are single-line.

/**
 * True when an exception carries framework internals that must not cross a
 * trust boundary (client bodies, external error sinks): Prisma client errors
 * (class name `Prisma*`, code `P####`, or the "`` invocation in" validation
 * banner) leak absolute build paths, table shapes and the dev-server chunk
 * map. Multi-line messages are treated as internal too — domain errors
 * thrown by the appliers are single-line.
 */
export function isInternalError(e: unknown): boolean {
  if (!(e instanceof Error)) return false
  const name = e.constructor?.name ?? e.name ?? ''
  const code = String((e as { code?: unknown }).code ?? '')
  return (
    name.startsWith('Prisma') ||
    /^P\d{4}$/.test(code) ||
    e.message.includes('` invocation in') ||
    e.message.includes('\n')
  )
}

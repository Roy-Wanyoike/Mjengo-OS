// Daraja pending-intent reconciliation sweep (issue #34) — the jobs-module
// half of the STK flow.
//
// daraja-callback.ts settles an intent when Safaricom DELIVERS the callback.
// When the callback is missed (Safaricom retried nothing, the proxy ate the
// POST, the app was briefly down) the intent row (daraja.intent:<Checkout
// RequestID>) stays PENDING forever and the PaymentRequest stays approved
// with no money recorded. This sweep closes that gap WITHOUT inventing a
// second money path:
//
//   · it FINDS unsettled intent rows (IdempotencyRecord keys
//     daraja.intent:*, written by payPaymentRequest at initiation);
//   · for each one it drives the EXISTING callback processor
//     (processDarajaStkCallback) with a synthesized Body.stkCallback carrying
//     only the CheckoutRequestID. The synthesized ResultCode is 0 and is
//     NEVER trusted for money: the callback processor queries the Daraja
//     stkpushquery API itself and only a VERIFIED result posts — exactly the
//     same dedupe (in-memory set + durable daraja.callback:<id>), the same
//     in-transaction status re-check, the same ledger idempotency key and
//     the same notification as a real callback. A sweep that settles an
//     intent is byte-for-byte the callback's money path; there is no
//     reconcile-specific credit anywhere.
//
// Consequently the sweep is idempotent and safe to run concurrently with a
// late-arriving real callback: whichever side settles first writes the
// durable daraja.callback:<id> record (and the ledger posting is keyed by
// the same value), so the loser becomes an honest 'duplicate' — no double
// post is possible from either side, in-process or cross-process.
//
// Never-invent rules (mirroring the callback):
//   · query says succeeded  → the callback processor posts the money;
//   · query says pending (incl. Daraja's "still processing" and UNMAPPED
//     ResultCodes) → nothing posted, intent STAYS pending, retried later;
//   · query says failed     → nothing posted and no durable record written
//     (a later genuine success callback can still credit — the callback
//     module's deliberate "failures are never recorded" rule);
//   · no intent row / request not approved / already paid → honest no-op.
//
// Scheduling (the honest model): there is no in-process scheduler — the
// jobs drainer (POST /api/jobs/run via the JOBS_RUN_TOKEN bearer path or a
// session; compose jobs-tick sidecar / systemd timer / cron in production)
// drains due rows. payPaymentRequest seeds a delayed wallet.reconcile row
// whenever it records a pending intent (runAt = now + after-min), and each
// sweep run schedules ONE follow-up row (runAt = now + interval) while any
// unsettled intent remains inside the probing window — so the 5-minute
// scheduler tick keeps re-probing until everything settles or ages out.
// Intents older than max-age are left alone forever (no invented failure,
// no invented credit): the request stays approved and can be re-initiated;
// the terminal state is Safaricom's to confirm.
//
// Tuning env (all optional; invalid values warn once per sweep and fall
// back to the default — ignore-invalid, never crash a money-adjacent job):
//   DARAJA_RECONCILE_AFTER_MIN     default 2   — probe intents only once
//                                                they are this old (minutes)
//   DARAJA_RECONCILE_INTERVAL_MIN  default 5   — follow-up spacing (matches
//                                                the scheduler tick cadence)
//   DARAJA_RECONCILE_MAX_AGE_MIN   default 60  — stop probing beyond this
//                                                age; intent stays pending
// All three unset → these defaults; with no Daraja env at all no intent
// rows ever exist, so the sweep seeds nothing and does nothing (the default
// deployment is unchanged).

import { db } from '@/backend/lib/db'
import { enqueue } from '@/backend/modules/jobs/service'
import { DARAJA_CALLBACK_KEY_PREFIX, DARAJA_INTENT_KEY_PREFIX, processDarajaStkCallback } from './daraja-callback'

/** The JobType this module registers (jobs/handlers.ts dispatches on it). */
export const DARAJA_RECONCILE_JOB_TYPE = 'wallet.reconcile'

/** Upper bound on intents probed (HTTP query each) per sweep run. */
const MAX_PROBE_PER_SWEEP = 25
/** Upper bound on sample detail lines kept in the job result JSON. */
const MAX_SAMPLES = 3

const DEFAULT_AFTER_MIN = 2
const DEFAULT_INTERVAL_MIN = 5
const DEFAULT_MAX_AGE_MIN = 60

/** Env tuning for the sweep (read at call time, daraja.ts pattern). */
export interface DarajaReconcileTuning {
  afterMin: number
  intervalMin: number
  maxAgeMin: number
}

function clean(v: string | undefined): string {
  return (v ?? '').trim()
}

function minutesFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = clean(env[name])
  if (!raw) return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) {
    console.warn(`[daraja-reconcile] ${name}="${raw}" is not a positive number — using the default (${fallback} min)`)
    return fallback
  }
  return n
}

/** Resolve the sweep tuning from env (invalid → default + one warn). */
export function darajaReconcileTuningFromEnv(env: NodeJS.ProcessEnv = process.env): DarajaReconcileTuning {
  return {
    afterMin: minutesFromEnv(env, 'DARAJA_RECONCILE_AFTER_MIN', DEFAULT_AFTER_MIN),
    intervalMin: minutesFromEnv(env, 'DARAJA_RECONCILE_INTERVAL_MIN', DEFAULT_INTERVAL_MIN),
    maxAgeMin: minutesFromEnv(env, 'DARAJA_RECONCILE_MAX_AGE_MIN', DEFAULT_MAX_AGE_MIN),
  }
}

export interface DarajaReconcileResult {
  /** Intent rows examined inside the probing window (max-age). */
  scanned: number
  /** Rows skipped because a durable daraja.callback:<id> already exists. */
  settledEarlier: number
  /** Unsettled rows not probed THIS run (younger than after-min, or past
   *  this run's probe budget) — a later sweep in the chain covers them. */
  tooYoung: number
  /** Rows driven through the callback processor this run. */
  probed: number
  /** Probed → 'credited': money posted NOW via the verified callback path. */
  credited: number
  /** Probed → 'duplicate': settled concurrently between scan and probe. */
  duplicate: number
  /** Probed → 'unverified': query says pending/failed (or provider not
   *  configured) — nothing posted, intent stays pending. */
  unverified: number
  /** Probed → 'ignored': honest no-op (no payable approved request). */
  ignored: number
  /** ISO time of the follow-up sweep this run scheduled (null = chain ended:
   *  no unsettled intent remains inside the probing window). */
  followUpAt: string | null
  /** A few honest per-intent detail lines for the job result / jobs card. */
  samples: string[]
  note: string
}

/** CheckoutRequestID is the intent key suffix — the only part we need. */
function checkoutOfIntentKey(key: string): string {
  return key.slice(DARAJA_INTENT_KEY_PREFIX.length)
}

/**
 * Schedule one wallet.reconcile row at runAt, unless a queued/retrying one
 * already exists (at most one scheduled sweep at a time — extra sweeps are
 * harmless no-ops, this just keeps the queue tidy). Returns the scheduled
 * runAt, or null when skipped. Storage errors PROPAGATE (a broken follow-up
 * chain must be loud: the drainer retries the sweep row itself).
 */
export async function scheduleDarajaReconcile(runAt: Date): Promise<Date | null> {
  const existing = await db.jobRecord.findFirst({
    where: { type: DARAJA_RECONCILE_JOB_TYPE, status: { in: ['queued', 'retrying'] } },
    select: { id: true },
  })
  if (existing) return null
  await enqueue(DARAJA_RECONCILE_JOB_TYPE, null, {}, runAt)
  return runAt
}

/**
 * Best-effort seed called by payPaymentRequest right after a pending intent
 * is recorded: schedule the first sweep for when the intent becomes probe-
 * eligible. Best-effort by design — a failed queue write is an honest gap
 * (the real callback and a manual re-pay still work; it never fails the
 * payment flow itself).
 */
export async function seedDarajaReconcileSweep(env: NodeJS.ProcessEnv = process.env): Promise<Date | null> {
  const { afterMin } = darajaReconcileTuningFromEnv(env)
  try {
    return await scheduleDarajaReconcile(new Date(Date.now() + afterMin * 60_000))
  } catch (e) {
    console.error('[daraja-reconcile] failed to seed the reconciliation sweep job', e)
    return null
  }
}

/**
 * One reconciliation sweep — the wallet.reconcile job handler. Storage
 * errors propagate (the jobs runner catches them, records lastError and
 * retries with backoff; re-running the sweep is idempotent).
 */
export async function runDarajaReconcile(): Promise<DarajaReconcileResult> {
  const tuning = darajaReconcileTuningFromEnv()
  const now = Date.now()
  // Intents inside the probing window: created within max-age. Anything
  // older is never probed again (stays pending honestly — see header).
  const windowStart = new Date(now - tuning.maxAgeMin * 60_000)
  // Probe-eligible: old enough for the provider to have a final answer.
  const afterCutoff = new Date(now - tuning.afterMin * 60_000)

  const intentRows = await db.idempotencyRecord.findMany({
    where: { key: { startsWith: DARAJA_INTENT_KEY_PREFIX }, createdAt: { gte: windowStart } },
    orderBy: { createdAt: 'asc' },
  })

  const result: DarajaReconcileResult = {
    scanned: 0, settledEarlier: 0, tooYoung: 0, probed: 0, credited: 0,
    duplicate: 0, unverified: 0, ignored: 0,
    followUpAt: null, samples: [], note: '',
  }
  const pushSample = (line: string) => {
    if (result.samples.length < MAX_SAMPLES) result.samples.push(line)
  }

  let probedBudget = MAX_PROBE_PER_SWEEP
  for (const row of intentRows) {
    result.scanned += 1
    const checkout = checkoutOfIntentKey(row.key)

    // Durable dedupe backstop: a completed callback record means settled —
    // by the real callback OR an earlier sweep. Nothing to do.
    const completed = await db.idempotencyRecord.findUnique({
      where: { key: `${DARAJA_CALLBACK_KEY_PREFIX}${checkout}` },
    })
    if (completed) {
      result.settledEarlier += 1
      continue
    }

    // Too young to probe this run — but unsettled, so the chain must stay
    // alive for it (counted, probed by a later sweep).
    if (row.createdAt > afterCutoff) {
      result.tooYoung += 1
      continue
    }
    if (probedBudget <= 0) {
      // Unsettled and probe-eligible, but over this run's probe budget —
      // counted as too-young-style "left for the follow-up" (the chain
      // schedules one below; the field name is honest in the note).
      result.tooYoung += 1
      continue
    }
    probedBudget -= 1
    result.probed += 1

    // Drive the REAL callback processor: it re-checks every dedupe layer,
    // queries stkpushquery itself, and only a verified result posts money.
    // The synthesized body carries ONLY the CheckoutRequestID — its
    // ResultCode is never trusted (the query is the gate, as always). The
    // 'reconcile-sweep' origin LABELS the posting's audit trail (callback vs
    // sweep) so finance can tell how a settlement was triggered; the money
    // mechanics are byte-identical to the callback path.
    const outcome = await processDarajaStkCallback(
      {
        Body: {
          stkCallback: {
            CheckoutRequestID: checkout,
            ResultCode: 0,
            ResultDesc: 'wallet.reconcile sweep probe',
          },
        },
      },
      'reconcile-sweep',
    )

    switch (outcome.action) {
      case 'credited':
        result.credited += 1
        pushSample(`checkout ${checkout}: ${outcome.detail}`)
        break
      case 'duplicate':
        // Settled between our scan and the probe (concurrent callback or
        // sweep) — the dedupe backstop doing its job.
        result.duplicate += 1
        pushSample(`checkout ${checkout}: ${outcome.detail}`)
        break
      case 'unverified':
        result.unverified += 1
        pushSample(`checkout ${checkout}: ${outcome.detail}`)
        break
      case 'ignored':
        result.ignored += 1
        pushSample(`checkout ${checkout}: ${outcome.detail}`)
        break
    }
  }

  // Chain continuation: any in-window intent without a callback record
  // (settledEarlier is the only settled bucket; everything else unsettled).
  const unsettledInWindow =
    result.tooYoung + result.probed - result.credited - result.duplicate
  if (unsettledInWindow > 0) {
    const followUpAt = new Date(now + tuning.intervalMin * 60_000)
    const scheduled = await scheduleDarajaReconcile(followUpAt)
    result.followUpAt = scheduled ? scheduled.toISOString() : null
    result.note =
      `${result.credited} settled, ${result.unverified} still pending, ${result.ignored} no-op` +
      `${result.tooYoung ? `, ${result.tooYoung} waiting for the next sweep` : ''}` +
      `${result.duplicate ? `, ${result.duplicate} settled concurrently` : ''}` +
      ` — follow-up scheduled${scheduled ? '' : ' (a queued sweep already exists)'}.` +
      ` Intents older than ${tuning.maxAgeMin} min stop being probed and stay PENDING (never an invented failure or credit).`
  } else {
    result.note =
      result.scanned === 0
        ? 'No pending Daraja intents inside the probing window — nothing to do.'
        : `${result.scanned} intent(s) in window, all settled — reconciliation chain ends.` +
          ` Intents older than ${tuning.maxAgeMin} min (if any) stay PENDING and need operator attention; the payment request stays approved and can be re-initiated.`
  }

  return result
}

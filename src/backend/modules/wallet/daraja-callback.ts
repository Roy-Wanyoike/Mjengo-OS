// M-Pesa Daraja callback processing — the async half of the STK flow.
//
// daraja.ts STARTS a payment (STK push → honest 'pending') and the wallet
// service records a PENDING INTENT row (IdempotencyRecord keyed
// daraja.intent:<CheckoutRequestID>). Safaricom then POSTs the result to the
// per-deployment secret webhook path (src/app/api/webhooks/daraja/[secret])
// which delegates HERE. Money only moves when ALL of these hold:
//
//   1. the callback carries a CheckoutRequestID we have not already completed
//      (in-memory Set + durable IdempotencyRecord — the existing wallet
//      Idempotency-Key pattern, spec §57);
//   2. the callback ResultCode is 0 AND the RECONCILIATION QUERY
//      (provider.verifyPayment — stkpushquery) independently says 'succeeded'
//      — the callback body alone is NEVER sufficient for money movement;
//   3. a pending intent row exists AND the backing PaymentRequest is still
//      'approved' for that amount — a callback with no matching intent is
//      acknowledged 200, never credited (no invented money). Since issue #211
//      such an orphan VERIFIED-SUCCESS callback is no longer SILENT: the
//      payer's money may really have moved (classically the STK push fetch
//      timed out before the CheckoutRequestID was learned, so no intent row
//      could exist) — console.warn + best-effort payment.orphaned
//      notifications correlated against the unresolved-initiation rows the
//      wallet service records at initiation time (see below). Fail-closed is
//      unchanged: nothing posts without an intent row.
//   4. the posting goes through the ledger module (postLedgerTransactionInTx)
//      with idempotencyKey daraja.callback:<CheckoutRequestID>, so even a
//      cross-process replay cannot double-post.
//
// HONEST LIMITS (documented, deliberate):
//   · Amount posted = the approved PaymentRequest amount re-read inside the
//     transaction (not the callback's untrusted CallbackMetadata amount — a
//     mismatch is logged for finance reconciliation, never silently posted).
//   · A callback that arrives while the query says pending/unverified is
//     acknowledged 200 with the honest reason, but nothing is posted and
//     Safaricom will NOT retry (we answered 2xx). A reconciliation sweep that
//     re-polls pending intents belongs in the jobs module — future work.
//   · Reversal (Result) callback bodies hit the same webhook and are
//     honestly ignored (only Body.stkCallback shapes are processed).

import { db } from '@/backend/lib/db'
import { centsToKes, fmtKes } from '@/backend/lib/money'
import { SYSTEM_PRINCIPAL } from '@/backend/lib/idempotency'
import { cashAccountForMethod, postLedgerTransactionInTx } from '@/backend/modules/ledger/service'
import { notify } from '@/backend/modules/notify/service'
import { phaseIdForMilestonePayment } from './service'
import { getDarajaProvider, msisdnFromPayee } from './daraja'
import { log } from '@/backend/lib/log'

export const DARAJA_INTENT_KEY_PREFIX = 'daraja.intent:'
export const DARAJA_CALLBACK_KEY_PREFIX = 'daraja.callback:'
/** Issue #211: initiation attempts whose OUTCOME IS UNKNOWN (push fetch
 *  timed out / network-died / unreadable 2xx body) — Safaricom may still have
 *  accepted the push, but the CheckoutRequestID is unrecoverable, so these
 *  rows can never be swept (the query API keys on it). They exist for finance
 *  reconciliation and to enrich the unmatched-callback alert. */
export const DARAJA_UNRESOLVED_KEY_PREFIX = 'daraja.unresolved:'

const INTENT_SCOPE = 'payment.provider_intent'
// #177: exported — daraja-reconcile.ts reads completed-callback markers
// through the same (principal, scope, key) composite; one definition so the
// write and the lookup cannot drift.
export const CALLBACK_SCOPE = 'payment.daraja_callback'
const UNRESOLVED_SCOPE = 'payment.provider_unresolved'

/** In-memory replay guard (single process; the DB record is the durable one). */
const seenCheckouts = new Set<string>()
const SEEN_CAP = 10_000

function rememberCheckout(checkoutRequestID: string) {
  if (seenCheckouts.size >= SEEN_CAP) {
    // Bounded: drop the oldest insertion (Sets iterate in insertion order).
    const oldest = seenCheckouts.values().next().value
    if (oldest !== undefined) seenCheckouts.delete(oldest)
  }
  seenCheckouts.add(checkoutRequestID)
}

/** Test-only: clear the in-memory dedupe set between test cases. */
export function resetDarajaCallbackStateForTests() {
  seenCheckouts.clear()
}

/** The pending intent recorded by the wallet service at initiation time. */
export interface DarajaIntentPayload {
  kind: 'payment.request'
  paymentRequestId: string
  requestCode: string
  projectId: string
  amount: number
  payee: string
  method: string
  reference: string
  /** CheckoutRequestID — also the IdempotencyRecord key suffix. */
  providerRef: string
  initiatedBy: string
  initiatedByRole: string
}

/**
 * An initiation whose outcome could not be determined (issue #211) — what the
 * wallet service knew AT initiation time when the provider answered 'failed'
 * with outcomeUnknown (push fetch threw / body unreadable). `providerRef` is
 * our own daraja-<ts> attempt marker, NOT a CheckoutRequestID — the row is
 * keyed by it so repeated attempts never collide. The sweep CANNOT resolve
 * these rows (stkpushquery needs the CheckoutRequestID); they exist so (a)
 * finance can reconcile against the M-Pesa portal and (b) a later
 * verified-success callback that matches no intent can be ALERTED against
 * them (payee phone + amount) — money still never auto-posts.
 */
export interface DarajaUnresolvedInitiationPayload {
  kind: 'payment.unresolved'
  paymentRequestId: string
  requestCode: string
  projectId: string
  amount: number
  payee: string
  method: string
  reference: string
  /** Attempt marker (daraja-<ts>), NOT a CheckoutRequestID. */
  providerRef: string
  initiatedBy: string
  initiatedByRole: string
  /** The provider's own honest failure line (why the outcome is unknown). */
  failureDetail: string
}

/**
 * Record the pending intent (called by payPaymentRequest when a real provider
 * returns 'pending'). Keyed daraja.intent:<CheckoutRequestID> — every STK
 * push gets a fresh CheckoutRequestID, so legitimate re-initiations never
 * collide. Throws bubble to the caller (the service logs best-effort).
 */
export async function recordDarajaIntent(intent: DarajaIntentPayload): Promise<void> {
  await db.idempotencyRecord.create({
    data: {
      // #177: server-generated markers live in the fixed 'system' principal
      // (keys are provider refs, never caller-chosen — migration 17 backfilled
      // the pre-#177 daraja rows to the same namespace).
      principal: SYSTEM_PRINCIPAL,
      key: `${DARAJA_INTENT_KEY_PREFIX}${intent.providerRef}`,
      scope: INTENT_SCOPE,
      projectId: intent.projectId,
      responseBody: JSON.stringify(intent),
    },
  })
}

/**
 * Record an unresolved initiation (issue #211) — the durable-intent pattern
 * applied at initiation time to the outcome-UNKNOWN class: a timed-out push
 * may still be live on Safaricom's side, so the known facts (request, amount,
 * payee, attempt marker, failure line) survive for finance reconciliation
 * and the unmatched-callback alert. Keyed
 * daraja.unresolved:<attempt-marker>:<paymentRequestId> — every timed-out
 * attempt is a distinct possible live checkout, and the request id keeps the
 * key unique even if two attempts land on the same millisecond. Throws
 * bubble to the caller (the service logs best-effort, never fails the pay
 * flow — the honest 'failed' error still surfaces to the operator).
 */
export async function recordDarajaUnresolvedInitiation(
  initiation: DarajaUnresolvedInitiationPayload,
): Promise<void> {
  await db.idempotencyRecord.create({
    data: {
      principal: SYSTEM_PRINCIPAL, // #177 — see recordDarajaIntent
      key: `${DARAJA_UNRESOLVED_KEY_PREFIX}${initiation.providerRef}:${initiation.paymentRequestId}`,
      scope: UNRESOLVED_SCOPE,
      projectId: initiation.projectId,
      responseBody: JSON.stringify(initiation),
    },
  })
}

/** Defensive intent parse — a row that is not exactly our shape is no intent. */
function parseIntent(row: { responseBody: string | null } | null): DarajaIntentPayload | null {
  if (!row?.responseBody) return null
  try {
    const v = JSON.parse(row.responseBody) as Record<string, unknown>
    if (v?.kind !== 'payment.request') return null
    const intent: DarajaIntentPayload = {
      kind: 'payment.request',
      paymentRequestId: String(v.paymentRequestId ?? ''),
      requestCode: String(v.requestCode ?? ''),
      projectId: String(v.projectId ?? ''),
      amount: Number(v.amount),
      payee: String(v.payee ?? ''),
      method: String(v.method ?? 'mpesa'),
      reference: String(v.reference ?? ''),
      providerRef: String(v.providerRef ?? ''),
      initiatedBy: String(v.initiatedBy ?? 'Finance'),
      initiatedByRole: String(v.initiatedByRole ?? 'finance'),
    }
    if (!intent.paymentRequestId || !intent.projectId || !(intent.amount > 0) || !intent.providerRef) return null
    return intent
  } catch {
    return null
  }
}

/** Defensive unresolved-initiation parse (same discipline as parseIntent). */
function parseUnresolved(row: { responseBody: string | null } | null): DarajaUnresolvedInitiationPayload | null {
  if (!row?.responseBody) return null
  try {
    const v = JSON.parse(row.responseBody) as Record<string, unknown>
    if (v?.kind !== 'payment.unresolved') return null
    const u: DarajaUnresolvedInitiationPayload = {
      kind: 'payment.unresolved',
      paymentRequestId: String(v.paymentRequestId ?? ''),
      requestCode: String(v.requestCode ?? ''),
      projectId: String(v.projectId ?? ''),
      amount: Number(v.amount),
      payee: String(v.payee ?? ''),
      method: String(v.method ?? 'mpesa'),
      reference: String(v.reference ?? ''),
      providerRef: String(v.providerRef ?? ''),
      initiatedBy: String(v.initiatedBy ?? 'Finance'),
      initiatedByRole: String(v.initiatedByRole ?? 'finance'),
      failureDetail: String(v.failureDetail ?? ''),
    }
    if (!u.paymentRequestId || !u.projectId || !(u.amount > 0) || !u.providerRef) return null
    return u
  } catch {
    return null
  }
}

export interface StkCallbackData {
  checkoutRequestID: string
  resultCode: number
  resultDesc: string
  /** From CallbackMetadata when present (UNTRUSTED — log-only, never posted). */
  amount?: number
  receipt?: string
  /** Payer MSISDN from CallbackMetadata when present (UNTRUSTED — used only
   *  to ENRICH the unmatched-callback alert of issue #211, never to post). */
  phone?: string
}

/** Safaricom STK callback shape: { Body: { stkCallback: { … } } }. */
export function extractStkCallback(body: unknown): StkCallbackData | null {
  if (!body || typeof body !== 'object') return null
  const outer = (body as Record<string, unknown>).Body
  if (!outer || typeof outer !== 'object') return null
  const cb = (outer as Record<string, unknown>).stkCallback
  if (!cb || typeof cb !== 'object') return null
  const c = cb as Record<string, unknown>
  const checkoutRequestID = typeof c.CheckoutRequestID === 'string' ? c.CheckoutRequestID.trim() : ''
  const resultCode = Number(c.ResultCode)
  if (!checkoutRequestID || !Number.isFinite(resultCode)) return null
  const data: StkCallbackData = {
    checkoutRequestID,
    resultCode,
    resultDesc: String(c.ResultDesc ?? '').slice(0, 200),
  }
  const meta = c.CallbackMetadata
  if (meta && typeof meta === 'object' && Array.isArray((meta as Record<string, unknown>).Item)) {
    for (const item of (meta as Record<string, unknown>).Item as Record<string, unknown>[]) {
      if (!item || typeof item !== 'object') continue
      if (item.Name === 'Amount' && Number.isFinite(Number(item.Value))) data.amount = Number(item.Value)
      if (item.Name === 'MpesaReceiptNumber' && typeof item.Value === 'string') data.receipt = item.Value
      if (item.Name === 'PhoneNumber') {
        const msisdn = msisdnFromPayee(item.Value)
        if (msisdn) data.phone = msisdn
      }
    }
  }
  return data
}

export type DarajaCallbackAction = 'credited' | 'duplicate' | 'ignored' | 'unverified'

export interface DarajaCallbackOutcome {
  ok: true
  action: DarajaCallbackAction
  detail: string
}

/**
 * What triggered a settlement — recorded in the money trail so finance can
 * tell a real Safaricom callback from the wallet.reconcile sweep re-driving
 * the exact same path (issue #34). The mechanics are identical either way.
 */
export type DarajaSettlementOrigin = 'callback' | 'reconcile-sweep'

/**
 * Process one parsed Safaricom callback body. Never throws on domain paths —
 * unexpected storage errors DO propagate so the route can 500 and Safaricom
 * retries (the ledger idempotency key makes retries money-safe).
 *
 * `origin` labels the trigger in the posting's audit trail: 'callback' (the
 * webhook — default) or 'reconcile-sweep' (the jobs-module sweep re-driving
 * this processor for a missed callback). Money movement is identical.
 */
export async function processDarajaStkCallback(
  body: unknown,
  origin: DarajaSettlementOrigin = 'callback',
): Promise<DarajaCallbackOutcome> {
  const cb = extractStkCallback(body)
  if (!cb) {
    return { ok: true, action: 'ignored', detail: 'No Body.stkCallback in payload — only STK result callbacks are processed (reversal Result bodies are logged, never posted)' }
  }
  const { checkoutRequestID, resultCode } = cb

  // 1. In-memory replay guard (fast path, single process).
  if (seenCheckouts.has(checkoutRequestID)) {
    return { ok: true, action: 'duplicate', detail: `Checkout ${checkoutRequestID} already processed in this process — nothing re-posted` }
  }

  // 2. Durable replay guard — completed callbacks only (failures are never
  //    recorded, so honest retries stay possible; see withIdempotency).
  const completed = await db.idempotencyRecord.findUnique({
    where: {
      principal_scope_key: {
        principal: SYSTEM_PRINCIPAL,
        scope: CALLBACK_SCOPE,
        key: `${DARAJA_CALLBACK_KEY_PREFIX}${checkoutRequestID}`,
      },
    },
  })
  if (completed) {
    rememberCheckout(checkoutRequestID)
    return { ok: true, action: 'duplicate', detail: `Checkout ${checkoutRequestID} already completed — replayed the original outcome, nothing re-posted` }
  }

  // 3. Non-success result: money did NOT move — honest ack, no posting.
  if (resultCode !== 0) {
    return { ok: true, action: 'ignored', detail: `ResultCode ${resultCode} — the payment did not complete (${cb.resultDesc}); nothing posted` }
  }

  // 4. RECONCILIATION — the callback body alone is never sufficient for
  //    money movement: query the provider before anything is posted.
  const provider = getDarajaProvider()
  if (!provider) {
    return { ok: true, action: 'unverified', detail: 'Daraja provider is not configured (incomplete env) — the callback cannot be verified, so nothing was posted' }
  }
  const verified = await provider.verifyPayment(checkoutRequestID)
  if (verified.status !== 'succeeded') {
    return {
      ok: true,
      action: 'unverified',
      detail: `Reconciliation query says ${verified.status} for checkout ${checkoutRequestID} — the callback claim is NOT confirmed, so nothing was posted (${verified.detail})`,
    }
  }

  // 5. Verified — post the money for the recorded intent (if one exists).
  const outcome = await completeVerifiedIntent(cb, origin)
  if (outcome.action === 'credited' || outcome.action === 'duplicate') rememberCheckout(checkoutRequestID)
  return outcome
}

/**
 * The money path: intent lookup → in-transaction status recheck → balanced
 * double-entry post through the ledger module → PaymentRequest marked paid.
 * `origin` only labels the audit trail (callback vs sweep) — never the checks.
 */
async function completeVerifiedIntent(
  cb: StkCallbackData,
  origin: DarajaSettlementOrigin,
): Promise<DarajaCallbackOutcome> {
  const { checkoutRequestID } = cb
  const originLabel = origin === 'reconcile-sweep' ? 'reconciliation sweep' : 'callback'
  const intentRow = await db.idempotencyRecord.findUnique({
    where: {
      principal_scope_key: {
        principal: SYSTEM_PRINCIPAL,
        scope: INTENT_SCOPE,
        key: `${DARAJA_INTENT_KEY_PREFIX}${checkoutRequestID}`,
      },
    },
  })
  const intent = parseIntent(intentRow)
  if (!intent) {
    // Issue #211: a VERIFIED-success callback with no intent row is real
    // money on the rail with no record here (classically: the push fetch
    // timed out, so the CheckoutRequestID — the intent key — was never
    // learned). Fail-closed is unchanged: nothing posts without an intent
    // row. But the old SILENT ignore is gone — break the silence for the
    // operator (console.warn + best-effort notifications correlated against
    // the unresolved-initiation rows recorded at initiation time).
    const alertNote = await alertUnmatchedVerifiedSuccess(cb)
    return {
      ok: true,
      action: 'ignored',
      detail: `No pending provider intent for checkout ${checkoutRequestID} — nothing posted (MjengoOS never invents a credit for an unmatched callback). ${alertNote}`,
    }
  }

  const result = await db.$transaction(async (tx) => {
    // Status re-check INSIDE the transaction — no double-pay race with the
    // in-app pay path (exactly like payPaymentRequest).
    const fresh = await tx.paymentRequest.findUnique({ where: { id: intent.paymentRequestId } })
    if (!fresh) return { posted: false as const, reason: `Payment request ${intent.requestCode} no longer exists` }
    if (fresh.status === 'paid') return { posted: false as const, reason: `${intent.requestCode} is already paid` }
    if (fresh.status !== 'approved') {
      return { posted: false as const, reason: `${intent.requestCode} is "${fresh.status}" (not approved) — a callback cannot pay an unapproved request` }
    }
    if (String(intent.method).toLowerCase() !== 'mpesa') {
      return { posted: false as const, reason: `Intent method "${intent.method}" is not the M-Pesa rail — nothing posted` }
    }

    // Amount = the APPROVED request amount, re-read in-tx. The callback's
    // CallbackMetadata amount is untrusted; a mismatch is logged below for
    // finance reconciliation — never silently posted, never blocking.
    const ledgerTxn = await postLedgerTransactionInTx(tx, {
      projectId: fresh.projectId,
      description: `Payment ${fresh.requestCode} — ${fresh.payee} (M-Pesa STK, verified ${originLabel})`,
      postedBy: intent.initiatedBy,
      postedRole: intent.initiatedByRole,
      idempotencyKey: `${DARAJA_CALLBACK_KEY_PREFIX}${checkoutRequestID}`,
      lines: [
        { accountCode: `EXPENSE:${fresh.projectId}`, side: 'debit', amount: fresh.amount },
        { accountCode: cashAccountForMethod('mpesa'), side: 'credit', amount: fresh.amount },
      ],
    })

    // Phase cost-code (issue #39): same derivation as the in-app pay path — a
    // request raised against a milestone pays that milestone's phase, derived
    // + validated INSIDE the transaction (fail-closed on a foreign phase; no
    // milestone linkage → null → the report estimates the row).
    const phaseId = await phaseIdForMilestonePayment(tx, fresh.projectId, fresh.relatedEntityType, fresh.relatedEntityId)

    // Exactly ONE legacy Transaction row per ledger txn (idempotent link).
    const txnRow =
      (await tx.transaction.findFirst({ where: { ledgerTxnId: ledgerTxn.id } })) ??
      (await tx.transaction.create({
        data: {
          projectId: fresh.projectId,
          type: 'payment_request',
          amount: fresh.amount,
          method: 'mpesa',
          reference: cb.receipt ? `MPESA-${cb.receipt}` : `MPESA-${checkoutRequestID.slice(-12)}`,
          costCode: 'payment_request',
          phaseId,
          ledgerTxnId: ledgerTxn.id,
          note: `${fresh.requestCode} — ${fresh.description} (M-Pesa verified ${originLabel} ${checkoutRequestID})`,
          date: new Date(),
        },
      }))

    await tx.paymentRequest.update({
      where: { id: fresh.id },
      data: { status: 'paid', paidAt: new Date(), paidTxnId: txnRow.id },
    })

    return { posted: true as const, ledgerRef: ledgerTxn.ref, amount: fresh.amount }
  })

  if (result.posted === false) {
    return { ok: true, action: 'ignored', detail: result.reason }
  }

  // Untrusted-body reconciliation log (metadata amount vs posted amount).
  if (cb.amount !== undefined && cb.amount !== centsToKes(result.amount)) {
    log.warn(
      'daraja-callback',
      `checkout ${checkoutRequestID}: callback metadata amount ${cb.amount} KSh differs from the approved ${intent.requestCode} amount ${fmtKes(result.amount)} — posted the approved amount; finance should reconcile`,
      { checkoutRequestID, requestCode: intent.requestCode },
    )
  }

  // Durable dedupe record AFTER the money committed (withIdempotency pattern:
  // failures are never recorded). A unique collision means a concurrent
  // duplicate already stored the outcome — the original stands.
  try {
    await db.idempotencyRecord.create({
      data: {
        principal: SYSTEM_PRINCIPAL, // #177 — see recordDarajaIntent
        key: `${DARAJA_CALLBACK_KEY_PREFIX}${checkoutRequestID}`,
        scope: CALLBACK_SCOPE,
        projectId: intent.projectId,
        responseBody: JSON.stringify({ checkoutRequestID, origin, ...result, amount: centsToKes(result.amount) }),
      },
    })
  } catch {
    /* concurrent duplicate — the durable record already exists */
  }

  // In-app notification (same kind as the normal pay path). The money has
  // already committed — a notify failure must never mask the outcome.
  try {
    await notify(
      intent.projectId,
      `Payment ${intent.requestCode} recorded`,
      `${fmtKes(result.amount)} to ${intent.payee} — M-Pesa ${originLabel} verified against the query API, ledger ${result.ledgerRef}`,
      { kind: 'payment.paid' },
    )
  } catch (e) {
    log.error('daraja-callback', 'notification failed after posting', { error: e })
  }

  return {
    ok: true,
    action: 'credited',
    detail: `Posted ledger ${result.ledgerRef} for ${intent.requestCode} (${fmtKes(result.amount)}) — callback verified, request marked paid`,
  }
}

/**
 * Issue #211 — the orphan verified-success alert. The callback (a) claimed
 * ResultCode 0, (b) the reconciliation query independently confirmed the
 * settlement, and (c) NO pending intent row matches the CheckoutRequestID —
 * so money left the customer's M-Pesa with no record in MjengoOS. Nothing
 * posts (fail-closed, always) — this helper only makes that LOUD:
 *
 *   · console.warn carries checkoutRequestID / receipt / amount for the log
 *     trail (with or without a matching unresolved initiation);
 *   · unresolved-initiation rows (what the wallet service could persist AT
 *     initiation time when the push outcome was unknown — see
 *     recordDarajaUnresolvedInitiation) are correlated by payer MSISDN and
 *     each candidate project gets ONE best-effort notification
 *     (kind 'payment.orphaned', finance audience) naming the candidate
 *     payment request(s), so finance can reconcile against the M-Pesa portal
 *     and record the payment manually.
 *
 * The correlation is deliberately heuristic — the CheckoutRequestID is
 * genuinely unrecoverable for a timed-out initiation, and Safaricom's STK
 * callback echoes no caller-chosen reference — and NOTHING about money ever
 * depends on it: a false match only produces a human-in-the-loop alert.
 * Best-effort by contract: storage/notification failures are logged, never
 * thrown into the callback outcome. Returns the honest detail suffix.
 */
async function alertUnmatchedVerifiedSuccess(cb: StkCallbackData): Promise<string> {
  const receipt = cb.receipt ?? 'unknown'
  const amount = cb.amount !== undefined ? `KSh ${cb.amount}` : 'unknown amount'
  log.warn(
    'daraja-callback',
    `verified M-Pesa success with NO pending intent — checkout ${cb.checkoutRequestID}, receipt ${receipt}, ${amount}. ` +
      `Money may have moved on the rail while MjengoOS posted nothing (fail-closed). If this was a timed-out initiation, reconcile against the M-Pesa portal.`,
    { checkoutRequestID: cb.checkoutRequestID, receipt, amount: cb.amount },
  )
  // No payer MSISDN in the callback metadata → nothing to correlate against
  // and no project to notify (notifications are per-project): the server log
  // line above is the whole honest signal.
  if (!cb.phone) {
    return 'Operator alerted via the server log (the callback metadata carried no payer phone — no project to notify).'
  }
  let candidates: DarajaUnresolvedInitiationPayload[] = []
  try {
    const rows = await db.idempotencyRecord.findMany({
      where: { key: { startsWith: DARAJA_UNRESOLVED_KEY_PREFIX } },
    })
    candidates = rows
      .map(parseUnresolved)
      .filter((u): u is DarajaUnresolvedInitiationPayload => u !== null && msisdnFromPayee(u.payee) === cb.phone)
    // One alert row per (project, request) even if several attempts timed out.
    const seen = new Set<string>()
    candidates = candidates.filter((c) => {
      const k = `${c.projectId}:${c.requestCode}`
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
  } catch (e) {
    log.error('daraja-callback', 'unresolved-initiation lookup failed while alerting the orphan callback', { error: e })
  }
  if (candidates.length === 0) {
    return 'Operator alerted via the server log (no unresolved initiation matched the payer — reconcile against the M-Pesa portal).'
  }
  const byProject = new Map<string, DarajaUnresolvedInitiationPayload[]>()
  for (const c of candidates) {
    const list = byProject.get(c.projectId) ?? []
    list.push(c)
    byProject.set(c.projectId, list)
  }
  const names = candidates.map((c) => `${c.requestCode} (KSh ${c.amount})`).join(', ')
  for (const [projectId, list] of byProject) {
    const codes = list.map((c) => c.requestCode).join(', ')
    try {
      await notify(
        projectId,
        'Unmatched M-Pesa payment — operator action needed',
        `A verified M-Pesa settlement (checkout ${cb.checkoutRequestID}, receipt ${receipt}, ${amount}) matches no recorded payment intent — it may belong to ${codes} (its initiation timed out before the checkout id was learned). Nothing was posted: reconcile against the M-Pesa portal and record the payment manually if confirmed.`,
        { kind: 'payment.orphaned', audienceRole: 'finance' },
      )
    } catch (e) {
      log.error('daraja-callback', 'orphan-callback notification failed', { error: e })
    }
  }
  return `Operator alerted (kind payment.orphaned) — possible source: ${names}.`
}

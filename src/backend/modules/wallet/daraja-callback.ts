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
//      logged and acknowledged 200, never credited (no invented money);
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
import { cashAccountForMethod, postLedgerTransactionInTx } from '@/backend/modules/ledger/service'
import { notify } from '@/backend/modules/notify/service'
import { phaseIdForMilestonePayment } from './service'
import { getDarajaProvider } from './daraja'

export const DARAJA_INTENT_KEY_PREFIX = 'daraja.intent:'
export const DARAJA_CALLBACK_KEY_PREFIX = 'daraja.callback:'

const INTENT_SCOPE = 'payment.provider_intent'
const CALLBACK_SCOPE = 'payment.daraja_callback'

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
 * Record the pending intent (called by payPaymentRequest when a real provider
 * returns 'pending'). Keyed daraja.intent:<CheckoutRequestID> — every STK
 * push gets a fresh CheckoutRequestID, so legitimate re-initiations never
 * collide. Throws bubble to the caller (the service logs best-effort).
 */
export async function recordDarajaIntent(intent: DarajaIntentPayload): Promise<void> {
  await db.idempotencyRecord.create({
    data: {
      key: `${DARAJA_INTENT_KEY_PREFIX}${intent.providerRef}`,
      scope: INTENT_SCOPE,
      projectId: intent.projectId,
      responseBody: JSON.stringify(intent),
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

export interface StkCallbackData {
  checkoutRequestID: string
  resultCode: number
  resultDesc: string
  /** From CallbackMetadata when present (UNTRUSTED — log-only, never posted). */
  amount?: number
  receipt?: string
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
 * Process one parsed Safaricom callback body. Never throws on domain paths —
 * unexpected storage errors DO propagate so the route can 500 and Safaricom
 * retries (the ledger idempotency key makes retries money-safe).
 */
export async function processDarajaStkCallback(body: unknown): Promise<DarajaCallbackOutcome> {
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
    where: { key: `${DARAJA_CALLBACK_KEY_PREFIX}${checkoutRequestID}` },
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
  const outcome = await completeVerifiedIntent(cb)
  if (outcome.action === 'credited' || outcome.action === 'duplicate') rememberCheckout(checkoutRequestID)
  return outcome
}

/**
 * The money path: intent lookup → in-transaction status recheck → balanced
 * double-entry post through the ledger module → PaymentRequest marked paid.
 */
async function completeVerifiedIntent(cb: StkCallbackData): Promise<DarajaCallbackOutcome> {
  const { checkoutRequestID } = cb
  const intentRow = await db.idempotencyRecord.findUnique({
    where: { key: `${DARAJA_INTENT_KEY_PREFIX}${checkoutRequestID}` },
  })
  const intent = parseIntent(intentRow)
  if (!intent) {
    return {
      ok: true,
      action: 'ignored',
      detail: `No pending provider intent for checkout ${checkoutRequestID} — nothing posted (MjengoOS never invents a credit for an unmatched callback)`,
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
      description: `Payment ${fresh.requestCode} — ${fresh.payee} (M-Pesa STK, verified callback)`,
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
          note: `${fresh.requestCode} — ${fresh.description} (M-Pesa verified callback ${checkoutRequestID})`,
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
  if (cb.amount !== undefined && cb.amount !== result.amount) {
    console.warn(
      `[daraja-callback] checkout ${checkoutRequestID}: callback metadata amount ${cb.amount} differs from the approved ${intent.requestCode} amount ${result.amount} — posted the approved amount; finance should reconcile`,
    )
  }

  // Durable dedupe record AFTER the money committed (withIdempotency pattern:
  // failures are never recorded). A unique collision means a concurrent
  // duplicate already stored the outcome — the original stands.
  try {
    await db.idempotencyRecord.create({
      data: {
        key: `${DARAJA_CALLBACK_KEY_PREFIX}${checkoutRequestID}`,
        scope: CALLBACK_SCOPE,
        projectId: intent.projectId,
        responseBody: JSON.stringify({ checkoutRequestID, ...result }),
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
      `KSh ${result.amount.toLocaleString()} to ${intent.payee} — M-Pesa callback verified against the query API, ledger ${result.ledgerRef}`,
      { kind: 'payment.paid' },
    )
  } catch (e) {
    console.error('[daraja-callback] notification failed after posting', e)
  }

  return {
    ok: true,
    action: 'credited',
    detail: `Posted ledger ${result.ledgerRef} for ${intent.requestCode} (KSh ${result.amount}) — callback verified, request marked paid`,
  }
}

// M-Pesa Daraja webhook — public documentation endpoint (no session, no money).
//
// The REAL callback handler lives one level down on a per-deployment
// UNGUESSABLE secret path: POST /api/webhooks/daraja/{segment} where segment
// = the first 32 hex chars of sha256(DARAJA_WEBHOOK_SECRET) (see
// src/backend/modules/wallet/daraja.ts — the same URL is embedded in every
// STK push CallBackURL). POSTing HERE (the guessable, secret-less path) can
// never move money: this route only explains the contract, mirroring the
// honest GET-docs pattern of /api/ussd.

import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

/** GET: the machine-readable contract (honest — no licensed integration). */
export async function GET() {
  return NextResponse.json({
    ok: true,
    endpoint: 'POST /api/webhooks/daraja/{secret-path-segment}',
    method: 'POST only on the secret path (this fixed path documents the contract)',
    body: {
      contentType: 'application/json (Safaricom sends JSON with a text/plain content-type quirk — the handler parses the raw body regardless)',
      shape: {
        Body: {
          stkCallback: {
            MerchantRequestID: 'string',
            CheckoutRequestID: 'string — the dedupe/reconciliation key',
            ResultCode: 'number — 0 = success, 1032 = user cancelled, …',
            ResultDesc: 'string',
            CallbackMetadata: 'optional { Item: [{ Name, Value }] } — Amount / MpesaReceiptNumber (UNTRUSTED, log-only)',
          },
        },
      },
    },
    security: {
      secretPath:
        'The URL segment is derived (sha256, 32 hex chars) from env DARAJA_WEBHOOK_SECRET — unguessable-by-construction, the pattern real payment aggregators use. The raw secret never appears in any URL. Wrong segment → 404.',
      replay:
        'Callbacks dedupe on CheckoutRequestID BEFORE anything is posted: an in-memory Set (per process) plus a durable IdempotencyRecord (daraja.callback:<id>) — the existing wallet Idempotency-Key pattern (spec §57). The ledger posting additionally carries the same key, so even a cross-process replay cannot double-post.',
      reconciliation:
        'The callback body is NEVER sufficient for money movement: before crediting, the handler queries the Daraja stkpushquery API (provider.verifyPayment) and only a verified ResultCode 0 posts the balanced double-entry through the ledger module.',
      network:
        'Origin checks mirror route-kit\u2019s MUTATION_ORIGIN_ALLOWLIST semantics (browser Origins are checked when the env is set; Safaricom\u2019s server-to-server POSTs carry no Origin and always pass). Safaricom source-IP allowlisting is NOT implemented (no published stable list) — the unguessable path + query-API reconciliation are the integrity model. TLS terminates at the reverse proxy in front of the app.',
      response:
        '2xx JSON { ok, action, detail } for every accepted event (duplicates, non-success results, unverified or unmatched callbacks included — honest reasons in detail, never a fake credit). Malformed JSON → 400. Unexpected internal errors → 500 (Safaricom retries; the durable dedupe + ledger idempotency make retries money-safe).',
    },
    completion:
      'Only Body.stkCallback shapes are processed. A verified success completes the PENDING intent recorded at initiation (payment request stays approved, no money moved) by posting EXPENSE/CASH_MPESA through the ledger module and marking the PaymentRequest paid. No matching intent → logged + 200, never an invented credit. Reversal (Result) bodies are logged and ignored.',
    honest:
      'Safaricom Daraja sandbox integration — real API shapes, zero live credentials, NOT a licensed integration; no real money. See src/backend/modules/wallet/daraja.ts and daraja-callback.ts.',
  })
}

/** POST on the guessable path: honestly refuse — money callbacks need the secret segment. */
export async function POST(req: NextRequest) {
  return NextResponse.json(
    {
      error:
        'Daraja callbacks are only accepted on the per-deployment secret path: POST /api/webhooks/daraja/{segment} (segment derived from DARAJA_WEBHOOK_SECRET — see GET /api/webhooks/daraja for the contract). This fixed path never processes money.',
    },
    { status: 400 },
  )
}

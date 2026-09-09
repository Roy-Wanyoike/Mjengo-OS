// M-Pesa Daraja provider (spec §40 — the PaymentProvider seam).
//
// HONESTY LABEL: this is a Safaricom Daraja SANDBOX integration — real API
// shapes, zero live credentials, NOT a licensed integration. In sandbox mode
// (DARAJA_ENV=sandbox, the default) no real money can move; `simulated: true`
// says exactly that on every result. Pointing DARAJA_ENV at production is
// shape-compatible but this code has never been certified with Safaricom —
// production results report `simulated: false` and the integrationNote keeps
// saying so honestly.
//
// Selection is fail-closed: darajaConfigFromEnv() returns a config ONLY when
// the full env set is present (key, secret, shortcode, passkey, callback base,
// webhook secret). Anything missing/blank → null → getProvider() keeps the
// SimulatedProvider (the default rail, unchanged).
//
// Why DARAJA_WEBHOOK_SECRET is part of the required set: every STK push sends
// a CallBackURL, and this integration's callbacks are only accepted on a
// per-deployment unguessable path segment DERIVED from that secret. Without
// it the callback URL would be guessable → the webhook route would refuse it
// → pushes could never complete. Fail closed at the factory instead.
//
// Contract details (developer.safaricom.co.ke):
//   · OAuth: GET  {base}/oauth/v1/generate?grant_type=client_credentials with
//     Authorization: Basic base64(consumerKey:consumerSecret). Tokens last
//     ~3600s; cached in memory with a 60s safety margin and refreshed ONCE on
//     a 401 from any API call.
//   · initiatePayment = STK push (CustomerPayBillOnline). STK is ASYNC: the
//     API accepting the push means the customer got a PIN prompt, NOT that
//     money moved → the result is honestly 'pending' with the
//     CheckoutRequestID as providerRef.
//   · verifyPayment = stkpushquery: ResultCode 0 = settled; known failure
//     codes (1032 user-cancelled, 1037 unreachable, 1 insufficient funds,
//     2001 invalid initiator) = 'failed'; anything else = 'pending' — an
//     UNMAPPED code is never treated as success (fail-closed on money).
//   · refund = reversal request — SEPARATE credentials (initiator name +
//     security credential); unset → honest 'failed', never a fake reversal.
//
// All HTTP goes through global fetch with AbortSignal.timeout(10s); every
// failure mode returns a ProviderResult instead of throwing, and detail
// strings leak nothing — error CLASS and HTTP status only, never URLs,
// credentials or stack traces.

import { createHash } from 'node:crypto'
import type { PaymentInitiation, PaymentProvider, ProviderResult } from './providers'

const REQUEST_TIMEOUT_MS = 10_000
/** Refresh the OAuth token this many ms before its documented expiry. */
const TOKEN_SAFETY_MARGIN_MS = 60_000

const OAUTH_PATH = '/oauth/v1/generate?grant_type=client_credentials'
const STK_PUSH_PATH = '/mpesa/stkpush/v1/processrequest'
const STK_QUERY_PATH = '/mpesa/stkpushquery/v1/query'
const REVERSAL_PATH = '/mpesa/reversal/v1/request'

const SANDBOX_BASE = 'https://sandbox.safaricom.co.ke'
const PRODUCTION_BASE = 'https://api.safaricom.co.ke'

/** Daraja STK query ResultCodes that are FINAL failures. */
const FAILED_RESULT_CODES: Record<string, string> = {
  '1': 'insufficient balance',
  '1032': 'request cancelled by the customer',
  '1037': 'customer unreachable (timeout)',
  '2001': 'initiator/receiver information invalid',
}

// ---------------------------------------------------------------------------
// configuration
// ---------------------------------------------------------------------------

export interface DarajaConfig {
  env: 'sandbox' | 'production'
  baseUrl: string
  consumerKey: string
  consumerSecret: string
  shortcode: string
  passkey: string
  callbackBase: string
  webhookSecret: string
  /** Reversal credentials — separate from the STK set; null = refund fails honestly. */
  initiatorName: string | null
  securityCredential: string | null
}

const clean = (v: string | undefined): string => (v ?? '').trim()

/**
 * Resolve the Daraja env — fail-closed: returns null unless EVERY required
 * value is present and non-blank. DARAJA_ENV only selects the API base
 * ('production' → api.safaricom.co.ke; anything else → sandbox default).
 * DARAJA_CALLBACK_BASE must be https (Safaricom rejects http callbacks).
 */
export function darajaConfigFromEnv(env: NodeJS.ProcessEnv = process.env): DarajaConfig | null {
  const consumerKey = clean(env.DARAJA_CONSUMER_KEY)
  const consumerSecret = clean(env.DARAJA_CONSUMER_SECRET)
  const shortcode = clean(env.DARAJA_SHORTCODE)
  const passkey = clean(env.DARAJA_PASSKEY)
  const callbackBase = clean(env.DARAJA_CALLBACK_BASE).replace(/\/+$/, '')
  const webhookSecret = clean(env.DARAJA_WEBHOOK_SECRET)
  if (!consumerKey || !consumerSecret || !shortcode || !passkey || !webhookSecret) return null
  if (!callbackBase.startsWith('https://')) return null
  const envLabel = clean(env.DARAJA_ENV).toLowerCase() === 'production' ? 'production' : 'sandbox'
  return {
    env: envLabel,
    baseUrl: envLabel === 'production' ? PRODUCTION_BASE : SANDBOX_BASE,
    consumerKey,
    consumerSecret,
    shortcode,
    passkey,
    callbackBase,
    webhookSecret,
    initiatorName: clean(env.DARAJA_INITIATOR_NAME) || null,
    securityCredential: clean(env.DARAJA_SECURITY_CREDENTIAL) || null,
  }
}

/**
 * The unguessable webhook path segment for this deployment: the first 32 hex
 * chars (128 bits) of sha256(DARAJA_WEBHOOK_SECRET). Derived, not the secret
 * itself — the raw secret never appears in a URL, a callback header or a log
 * line; only the STK CallBackURL carries the derived segment.
 */
export function darajaWebhookSegment(webhookSecret: string): string {
  return createHash('sha256').update(webhookSecret).digest('hex').slice(0, 32)
}

/** Full STK callback URL embedded in every push (and the reversal ResultURL). */
export function darajaCallbackUrl(config: DarajaConfig): string {
  return `${config.callbackBase}/api/webhooks/daraja/${darajaWebhookSegment(config.webhookSecret)}`
}

// ---------------------------------------------------------------------------
// provider instance cache (env read at call time — see notify/channels.ts)
// ---------------------------------------------------------------------------

let cachedEnvKey: string | null = null
let cachedProvider: DarajaProvider | null = null

/**
 * The strict factory: a DarajaProvider instance when the env set is complete,
 * null otherwise. Cached per distinct config so the OAuth token survives
 * between calls; a config change (e.g. tests flipping env) mints a fresh
 * instance with a cold token cache. getProvider('mpesa') falls back to the
 * SimulatedProvider when this returns null.
 */
/** Test-only: drop the cached instance (and its OAuth token) between cases. */
export function resetDarajaProviderCacheForTests() {
  cachedEnvKey = null
  cachedProvider = null
}
export function getDarajaProvider(env: NodeJS.ProcessEnv = process.env): DarajaProvider | null {
  const config = darajaConfigFromEnv(env)
  if (!config) {
    cachedEnvKey = null
    cachedProvider = null
    return null
  }
  const envKey = JSON.stringify(config)
  if (!cachedProvider || cachedEnvKey !== envKey) {
    cachedProvider = new DarajaProvider(config)
    cachedEnvKey = envKey
  }
  return cachedProvider
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Leak-free description of a thrown fetch/network/timeout error. */
function networkDetail(e: unknown): string {
  const name = e instanceof Error ? e.name : 'Error'
  if (name === 'TimeoutError' || name === 'AbortError') return `Daraja request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`
  if (name === 'TypeError') return 'Daraja API unreachable (network error)'
  return `Daraja request failed (network error: ${name})`
}

/**
 * Daraja timestamps are East Africa Time (UTC+3), format YYYYMMDDHHmmss —
 * the same value feeds the Password (base64(shortcode + passkey + timestamp)).
 */
export function darajaTimestamp(now: Date = new Date()): string {
  const eat = new Date(now.getTime() + 3 * 60 * 60 * 1000)
  const p = (n: number) => String(n).padStart(2, '0')
  return (
    `${eat.getUTCFullYear()}${p(eat.getUTCMonth() + 1)}${p(eat.getUTCDate())}` +
    `${p(eat.getUTCHours())}${p(eat.getUTCMinutes())}${p(eat.getUTCSeconds())}`
  )
}

/** STK push Password for a timestamp: base64(shortcode + passkey + timestamp). */
export function darajaPassword(config: DarajaConfig, timestamp: string): string {
  return Buffer.from(`${config.shortcode}${config.passkey}${timestamp}`).toString('base64')
}

/**
 * Normalize a payee into a Kenyan MSISDN (254 + 9 digits starting 7/1).
 * Returns null for anything phone-unshaped — an STK push without a reachable
 * handset is rejected BEFORE any HTTP call (fail closed, honest detail).
 */
export function msisdnFromPayee(payee: unknown): string | null {
  const digits = String(payee ?? '').replace(/\D/g, '')
  if (/^254[17]\d{8}$/.test(digits)) return digits
  if (/^0[17]\d{8}$/.test(digits)) return `254${digits.slice(1)}`
  if (/^[17]\d{8}$/.test(digits)) return `254${digits}`
  return null
}

// ---------------------------------------------------------------------------
// the provider
// ---------------------------------------------------------------------------

export class DarajaProvider implements PaymentProvider {
  readonly id = 'mpesa-daraja'
  readonly label: string
  readonly integrationNote: string

  /** In-memory OAuth token cache (single process; 401 forces one refresh). */
  private token: { value: string; expiresAt: number } | null = null

  constructor(private readonly config: DarajaConfig) {
    this.label = `M-Pesa (Daraja ${config.env})`
    this.integrationNote =
      config.env === 'production'
        ? 'Safaricom Daraja production shapes — NOT a licensed integration; real credentials would move real money (uncertified)'
        : 'Safaricom Daraja sandbox — NOT a licensed integration; no real money'
  }

  /** sandbox = honest `simulated: true` (no real money can move there). */
  private get simulated(): boolean {
    return this.config.env === 'sandbox'
  }

  private failed(providerRef: string, detail: string): ProviderResult {
    return { providerRef, status: 'failed', simulated: this.simulated, detail }
  }

  private pending(providerRef: string, detail: string): ProviderResult {
    return { providerRef, status: 'pending', simulated: this.simulated, detail }
  }

  /**
   * OAuth token, cached until the safety margin. `force` clears the cache
   * first (the one-refresh-on-401 path). Returns null on failure — callers
   * translate that into an honest failed result.
   */
  private async fetchToken(force: boolean): Promise<string | null> {
    if (!force && this.token && this.token.expiresAt > Date.now()) return this.token.value
    const basic = Buffer.from(`${this.config.consumerKey}:${this.config.consumerSecret}`).toString('base64')
    const res = await fetch(`${this.config.baseUrl}${OAUTH_PATH}`, {
      headers: { Authorization: `Basic ${basic}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!res.ok) return null
    const body = (await res.json().catch(() => null)) as { access_token?: unknown; expires_in?: unknown } | null
    const value = typeof body?.access_token === 'string' ? body.access_token : ''
    if (!value) return null
    const expiresInMs = Number(body?.expires_in ?? 0) * 1000
    this.token = { value, expiresAt: Date.now() + Math.max(0, expiresInMs - TOKEN_SAFETY_MARGIN_MS) }
    return value
  }

  /**
   * One authenticated Daraja POST. A 401 clears the token cache, refreshes
   * ONCE and retries the request once — then whatever came back stands.
   * Network/timeout errors are normalized into a failed response shape.
   */
  private async darajaPost(path: string, body: unknown): Promise<DarajaHttpResponse> {
    let token = await this.fetchToken(false)
    if (!token) return { ok: false, status: 401, json: null, authFailed: true }
    const url = `${this.config.baseUrl}${path}`
    const init = (bearer: string): RequestInit => ({
      method: 'POST',
      headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    try {
      let res = await fetch(url, init(token))
      if (res.status === 401) {
        token = await this.fetchToken(true)
        if (!token) return { ok: false, status: 401, json: null, authFailed: true }
        res = await fetch(url, init(token))
      }
      const json = (await res.json().catch(() => null)) as Record<string, unknown> | null
      return { ok: res.ok, status: res.status, json, authFailed: false }
    } catch (e) {
      return { ok: false, status: 0, json: null, authFailed: false, networkError: networkDetail(e) }
    }
  }

  // ---- initiatePayment: STK push (CustomerPayBillOnline) ------------------

  async initiatePayment(input: PaymentInitiation): Promise<ProviderResult> {
    const ref = `daraja-${Date.now().toString(36)}`
    try {
      if (!(input.amount > 0)) {
        return this.failed(ref, `M-Pesa STK push requires a positive amount — got ${input.amount}`)
      }
      if (!Number.isInteger(input.amount)) {
        return this.failed(ref, `M-Pesa STK push requires whole-shilling amounts — got ${input.amount} (no silent rounding on money)`)
      }
      if (String(input.currency ?? 'KES').toUpperCase() !== 'KES') {
        return this.failed(ref, `M-Pesa settles KES only — got ${input.currency}`)
      }
      const phone = msisdnFromPayee(input.payee)
      if (!phone) {
        return this.failed(ref, 'M-Pesa STK push needs an MSISDN payee (2547… / 07… / 7…) — the payee on this request is not phone-shaped')
      }
      const timestamp = darajaTimestamp(new Date())
      const r = await this.darajaPost(STK_PUSH_PATH, {
        BusinessShortCode: this.config.shortcode,
        Password: darajaPassword(this.config, timestamp),
        Timestamp: timestamp,
        TransactionType: 'CustomerPayBillOnline',
        Amount: input.amount,
        PartyA: phone,
        PartyB: this.config.shortcode,
        PhoneNumber: phone,
        CallBackURL: darajaCallbackUrl(this.config),
        AccountReference: input.reference,
        TransactionDesc: String(input.description ?? input.reference ?? 'Payment').slice(0, 20),
      })
      if (r.authFailed) return this.failed(ref, 'Daraja authentication failed — check DARAJA_CONSUMER_KEY / DARAJA_CONSUMER_SECRET')
      if (r.networkError) return this.failed(ref, r.networkError)
      if (!r.ok) {
        return this.failed(ref, `Daraja STK push rejected (HTTP ${r.status})`)
      }
      const checkout = typeof r.json?.CheckoutRequestID === 'string' ? r.json.CheckoutRequestID : ''
      const responseCode = String(r.json?.ResponseCode ?? '')
      if (responseCode !== '0' || !checkout) {
        const why = String(r.json?.ResponseDescription ?? r.json?.errorMessage ?? 'no description').slice(0, 160)
        return this.failed(ref, `Daraja did not accept the STK push (ResponseCode ${responseCode || 'missing'}): ${why}`)
      }
      // STK is async: the API accepting the request means the customer
      // received a PIN prompt — NOT that money moved. Honest status: pending.
      return this.pending(
        checkout,
        `STK push accepted (checkout ${checkout}) — awaiting the customer's M-Pesa confirmation; the verified callback records the payment`,
      )
    } catch (e) {
      return this.failed(ref, networkDetail(e))
    }
  }

  // ---- verifyPayment: stkpushquery ----------------------------------------

  async verifyPayment(providerRef: string): Promise<ProviderResult> {
    try {
      const timestamp = darajaTimestamp(new Date())
      const r = await this.darajaPost(STK_QUERY_PATH, {
        BusinessShortCode: this.config.shortcode,
        Password: darajaPassword(this.config, timestamp),
        Timestamp: timestamp,
        CheckoutRequestID: providerRef,
      })
      if (r.authFailed) return this.failed(providerRef, 'Daraja authentication failed — check DARAJA_CONSUMER_KEY / DARAJA_CONSUMER_SECRET')
      if (r.networkError) return this.failed(providerRef, r.networkError)
      if (!r.ok) {
        // Daraja's documented "transaction is being processed" error comes
        // back as HTTP 500 + errorCode 500.001.1001 — honest pending, not a
        // failure (the query should be retried).
        const errorCode = String(r.json?.errorCode ?? '')
        if (errorCode.startsWith('500.001.1001')) {
          return this.pending(providerRef, "Daraja is still processing this transaction (errorCode 500.001.1001) — query again")
        }
        return this.failed(providerRef, `Daraja query rejected (HTTP ${r.status})`)
      }
      const resultCode = r.json?.ResultCode
      if (resultCode === undefined || resultCode === null) {
        return this.pending(providerRef, 'Query accepted but no result yet — retry')
      }
      const code = String(resultCode)
      if (code === '0') {
        const desc = String(r.json?.ResultDesc ?? 'processed successfully').slice(0, 160)
        return { providerRef, status: 'succeeded', simulated: this.simulated, detail: `Daraja query confirms settlement — ${desc}` }
      }
      const known = FAILED_RESULT_CODES[code]
      if (known) {
        return this.failed(providerRef, `Daraja ResultCode ${code} — ${known}`)
      }
      // Unmapped code: NEVER succeeded (fail closed on money) — honest
      // pending so the reconciliation query can be retried / investigated.
      return this.pending(providerRef, `Daraja ResultCode ${code} is not a known final result — treated as pending, never as success`)
    } catch (e) {
      return this.failed(providerRef, networkDetail(e))
    }
  }

  // ---- refund: reversal request --------------------------------------------

  async refund(providerRef: string, amount: number): Promise<ProviderResult> {
    try {
      const initiator = this.config.initiatorName
      const credential = this.config.securityCredential
      if (!initiator || !credential) {
        return this.failed(
          providerRef,
          'M-Pesa reversal NOT attempted — reversal needs separate credentials (DARAJA_INITIATOR_NAME + DARAJA_SECURITY_CREDENTIAL, produced from the initiator password with Safaricom org certificate offline); both are unset. The provider-side refund is not available; an operator can post a compensating ledger reversal instead.',
        )
      }
      if (!(amount > 0) || !Number.isInteger(amount)) {
        return this.failed(providerRef, `M-Pesa reversal requires a positive whole-shilling amount — got ${amount}`)
      }
      // Sandbox-shaped reversal request. Note: "RecieverIdentifierType" is
      // Safaricom's own documented (misspelled) field name — kept verbatim.
      const r = await this.darajaPost(REVERSAL_PATH, {
        CommandID: 'TransactionReversal',
        InitiatorName: initiator,
        SecurityCredential: credential,
        TransactionID: providerRef,
        Amount: amount,
        ReceiverParty: this.config.shortcode,
        RecieverIdentifierType: '11',
        ResultURL: darajaCallbackUrl(this.config),
        Occasion: 'MjengoOS refund',
        Remarks: 'Refund requested from MjengoOS',
      })
      if (r.authFailed) return this.failed(providerRef, 'Daraja authentication failed — check DARAJA_CONSUMER_KEY / DARAJA_CONSUMER_SECRET')
      if (r.networkError) return this.failed(providerRef, r.networkError)
      if (!r.ok) {
        return this.failed(providerRef, `Daraja reversal request rejected (HTTP ${r.status})`)
      }
      const responseCode = String(r.json?.ResponseCode ?? '')
      if (responseCode !== '0') {
        const why = String(r.json?.ResponseDescription ?? 'no description').slice(0, 160)
        return this.failed(providerRef, `Daraja did not accept the reversal request (ResponseCode ${responseCode || 'missing'}): ${why}`)
      }
      // The reversal API is async: this acknowledges the REQUEST; the actual
      // reversal result arrives on the ResultURL callback, whose Result shape
      // this integration does not process (honestly documented) — so the
      // honest status is pending, never succeeded.
      return this.pending(
        providerRef,
        `Reversal request accepted for ${providerRef} — the result arrives on the ResultURL callback, which this integration logs but does not process; reconcile via the ledger before treating it as reversed`,
      )
    } catch (e) {
      return this.failed(providerRef, networkDetail(e))
    }
  }
}

/** Normalized Daraja HTTP outcome (network errors included, never thrown). */
export interface DarajaHttpResponse {
  ok: boolean
  status: number
  json: Record<string, unknown> | null
  /** OAuth failed — no bearer token could be obtained. */
  authFailed: boolean
  /** Leak-free network-error detail (set when the fetch threw/timed out). */
  networkError?: string
}

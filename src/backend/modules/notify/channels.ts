// Notifications module — external channel providers (the provider seam).
//
// The ChannelProvider interface is how notify() reaches people who are not
// staring at the app. SMS is wired today in two flavors behind the same
// interface — WebhookSmsProvider (generic gateway) and AtSmsProvider
// (Africa's Talking REST); WhatsApp and email are future providers that
// implement the same interface and get resolved in service.ts — no new
// concepts needed.
//
// Honest by construction:
//   · A provider is only "configured" when its env is present — no URL, no
//     send; the notification row stays 'logged' (fail-closed, never fakes a
//     delivery).
//   · send() NEVER throws: every failure mode (timeout, non-2xx, network
//     error) comes back as { status: 'failed', detail } with an operator-
//     readable detail that leaks nothing internal — error CLASS only, never
//     stack traces, API keys or provider URLs (fetch error messages can
//     embed URLs).
//
// CREDENTIAL TRADEOFF (the operator's choice — both documented, both real):
//   · WebhookSmsProvider keeps provider credentials OUT of this app: the
//     gateway you own holds the Twilio/AT secrets and we only POST JSON to
//     it. One more moving part to run, zero secrets on the app server.
//   · AtSmsProvider calls Africa's Talking REST directly — no relay to
//     operate, but the app env then HOLDS the AT API key (AT_API_KEY +
//     AT_USERNAME). That key can send (and bill) SMS on your account:
//     env-file discipline (never committed, narrow read access) is the
//     mitigation. Webhook keeps precedence when both are configured — an
//     existing webhook deployment never changes behavior by adding AT vars.

// ── WebhookSmsProvider contract (env: NOTIFY_SMS_WEBHOOK_URL) ──────────────
//
// Generic SMS-gateway webhook: works with a plain relay you own, a
// Twilio-proxy, or an Africa's Talking-style callback endpoint. The gateway
// receives exactly one JSON POST per attempted SMS:
//
//   POST ${NOTIFY_SMS_WEBHOOK_URL}
//   Content-Type: application/json
//   Authorization: Bearer ${NOTIFY_SMS_WEBHOOK_TOKEN}     // header only if set
//   {
//     "to":       "+2547XXXXXXXX",     // E.164 recommended, passed through as-is
//     "text":     "Title\n\nBody",     // the full SMS body (title + blank line + body)
//     "metadata": { "projectId": "…", "kind": "…" }   // for routing / dedupe
//   }
//
// Response handling (the whole contract):
//   · any 2xx  → the gateway accepted the message = 'sent'. The body MAY be
//                JSON with a string `id` (or `providerRef`) — recorded as
//                providerRef for later correlation. Non-JSON/empty body is
//                fine; the ref is best-effort.
//   · non-2xx  → 'failed', detail carries the HTTP status.
//   · timeout  → 'failed' after 8s (AbortSignal.timeout — a stuck gateway
//                can never hang notify()).
//   · network  → 'failed', detail carries the error class only (e.g.
//                TypeError) — the URL/cause stays out of the row.
//
// The app holds no provider credentials beyond the optional bearer token;
// actual provider auth (Twilio SID/token, AT API key, …) lives in the gateway.

// ── AtSmsProvider contract (env: AT_API_KEY + AT_USERNAME) ────────────────
//
// Direct Africa's Talking REST v1 messaging call — the dominant Kenyan
// aggregator — for teams that standardize on AT and don't want to run a
// webhook relay. Mirrors WebhookSmsProvider exactly (same interface, same
// 8s timeout, same leak-free failure details). The request is the real AT
// REST shape, form-urlencoded (NOT JSON):
//
//   POST https://api.africaistalking.com/version1/messaging
//   Content-Type: application/x-www-form-urlencoded
//   apiKey: ${AT_API_KEY}                              // AT's auth header
//   username=${AT_USERNAME}&to=+2547XXXXXXXX&message=…&from=${AT_SENDER_ID}
//
//   · to        — the destination number, passed through as-is (E.164
//                 recommended; AT also accepts local 07.. format).
//   · message   — the full SMS body (title + blank line + body, exactly
//                 what the webhook provider sends as `text`).
//   · from      — AT_SENDER_ID, ONLY when set: a registered short code /
//                 alphanumeric sender id. Unset → AT uses the account's
//                 default sender (sandbox: the shared 7000-something id).
//   · username  — the AT account username ("sandbox" on sandbox accounts).
//   · AT_ENV=sandbox selects the sandbox host
//     (api.sandbox.africaistalking.com) for credential testing without
//     spending credit — anything else/unset = production host. Mirrors the
//     DARAJA_ENV pattern of the wallet module.
//
// Response handling (mirrors the webhook contract):
//   · 2xx → 'sent'. The body is JSON
//     { SMSMessageData: { Recipients: [{ messageId, … }], Message } } — the
//     first recipient's messageId is recorded as providerRef (best-effort:
//     a non-JSON/odd body is still 'sent', just without a ref).
//   · non-2xx → 'failed', detail carries the HTTP status ONLY — never the
//     body (an AT error body could echo request material; status suffices).
//   · timeout  → 'failed' after 8s (AbortSignal.timeout — a stuck AT API
//                can never hang notify()).
//   · network  → 'failed', detail carries the error class only (e.g.
//                TypeError) — the key/host stays out of the row.

/** Africa's Talking REST hosts (AT_ENV=sandbox switches to the sandbox one). */
const AT_PROD_BASE = 'https://api.africaistalking.com'
const AT_SANDBOX_BASE = 'https://api.sandbox.africaistalking.com'

/** One attempted delivery to one external channel. */
export interface ChannelSendInput {
  to: string
  title: string
  body: string
  projectId: string
  kind: string
}

/** The honest outcome of one attempt — never thrown, always returned. */
export interface ChannelSendResult {
  ok: boolean
  status: 'sent' | 'failed'
  /** Provider-side reference (e.g. gateway message id) when one is available. */
  providerRef?: string
  /** Operator-readable, leak-free detail recorded in Notification.deliveryDetail. */
  detail: string
}

/** A delivery channel (SMS today; WhatsApp/email are future implementations). */
export interface ChannelProvider {
  readonly id: string
  readonly label: string
  send(input: ChannelSendInput): Promise<ChannelSendResult>
}

/** Hard cap on any single provider call — 8s, then the attempt fails honestly. */
const SEND_TIMEOUT_MS = 8_000

/**
 * The default SMS provider: a JSON POST to a generic SMS webhook (keeps all
 * provider credentials in the gateway — the documented tradeoff above).
 * Built via getSmsProvider() so the env is read at call time (never cached
 * across a long-lived process — or across tests).
 */
export class WebhookSmsProvider implements ChannelProvider {
  readonly id = 'webhook-sms'
  readonly label = 'SMS webhook gateway'

  constructor(
    private readonly url: string,
    private readonly token?: string,
  ) {}

  async send(input: ChannelSendInput): Promise<ChannelSendResult> {
    try {
      const res = await fetch(this.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        },
        body: JSON.stringify({
          to: input.to,
          text: `${input.title}\n\n${input.body}`,
          metadata: { projectId: input.projectId, kind: input.kind },
        }),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      })

      if (!res.ok) {
        return { ok: false, status: 'failed', detail: `SMS gateway responded HTTP ${res.status}` }
      }

      // 2xx = the gateway accepted the message. Best-effort ref capture:
      // body MAY be JSON { "id": "…" } (or { "providerRef": "…" }).
      const providerRef = await readProviderRef(res)
      return {
        ok: true,
        status: 'sent',
        ...(providerRef ? { providerRef } : {}),
        detail: providerRef ? `SMS gateway accepted (ref ${providerRef})` : 'SMS gateway accepted',
      }
    } catch (err) {
      // Never throw into the caller. Error CLASS only in the detail —
      // messages/causes can embed internal URLs, stack traces stay out.
      const name = err instanceof Error ? err.name : 'unknown'
      if (name === 'TimeoutError') {
        return { ok: false, status: 'failed', detail: `SMS gateway timed out after ${SEND_TIMEOUT_MS / 1000}s` }
      }
      return { ok: false, status: 'failed', detail: `SMS gateway unreachable (${name})` }
    }
  }
}

/** Read an optional { id } / { providerRef } string from a 2xx body — best-effort. */
async function readProviderRef(res: Response): Promise<string | undefined> {
  try {
    const parsed: unknown = JSON.parse(await res.text())
    if (parsed && typeof parsed === 'object') {
      const ref = (parsed as Record<string, unknown>).providerRef ?? (parsed as Record<string, unknown>).id
      if (typeof ref === 'string' && ref) return ref
    }
  } catch {
    // not JSON / empty body — no ref, still 'sent'
  }
  return undefined
}

/**
 * Direct Africa's Talking REST provider — for teams standardized on AT.
 * Same honesty rules as WebhookSmsProvider: never throws, 8s cap, leak-free
 * details (no API key, no host) on every failure path.
 */
export class AtSmsProvider implements ChannelProvider {
  readonly id = 'at-sms'
  readonly label = "Africa's Talking SMS"

  constructor(
    private readonly apiKey: string,
    private readonly username: string,
    private readonly senderId?: string,
    private readonly baseUrl: string = AT_PROD_BASE,
  ) {}

  async send(input: ChannelSendInput): Promise<ChannelSendResult> {
    try {
      // The real AT REST v1 shape: form-urlencoded fields, apiKey header.
      const form = new URLSearchParams({
        username: this.username,
        to: input.to,
        message: `${input.title}\n\n${input.body}`,
        ...(this.senderId ? { from: this.senderId } : {}),
      })
      const res = await fetch(`${this.baseUrl}/version1/messaging`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
          apikey: this.apiKey,
        },
        body: form.toString(),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      })

      if (!res.ok) {
        // Status ONLY — the AT error body is not echoed (leak-free).
        return { ok: false, status: 'failed', detail: `Africa's Talking responded HTTP ${res.status}` }
      }

      // 2xx = AT accepted the message. Best-effort ref capture from the real
      // response shape: SMSMessageData.Recipients[0].messageId.
      const providerRef = await readAtMessageId(res)
      return {
        ok: true,
        status: 'sent',
        ...(providerRef ? { providerRef } : {}),
        detail: providerRef
          ? `Africa's Talking accepted (messageId ${providerRef})`
          : `Africa's Talking accepted`,
      }
    } catch (err) {
      // Never throw into the caller. Error CLASS only in the detail — an
      // AT fetch failure message can embed the host/URL; it stays out.
      const name = err instanceof Error ? err.name : 'unknown'
      if (name === 'TimeoutError') {
        return { ok: false, status: 'failed', detail: `Africa's Talking timed out after ${SEND_TIMEOUT_MS / 1000}s` }
      }
      return { ok: false, status: 'failed', detail: `Africa's Talking unreachable (${name})` }
    }
  }
}

/** Read SMSMessageData.Recipients[0].messageId from a 2xx AT body — best-effort. */
async function readAtMessageId(res: Response): Promise<string | undefined> {
  try {
    const parsed: unknown = JSON.parse(await res.text())
    if (parsed && typeof parsed === 'object') {
      const data = (parsed as Record<string, unknown>).SMSMessageData
      if (data && typeof data === 'object') {
        const recipients = (data as Record<string, unknown>).Recipients
        if (Array.isArray(recipients)) {
          const first = recipients[0] as Record<string, unknown> | undefined
          const ref = first?.messageId
          if (typeof ref === 'string' && ref) return ref
        }
      }
    }
  } catch {
    // not JSON / empty body — no ref, still 'sent'
  }
  return undefined
}

/**
 * Resolve the SMS provider from env, at call time. Precedence (documented,
 * backwards compatible): webhook FIRST (a webhook deployment is unchanged by
 * AT env appearing), then the Africa's Talking pair, else null → no external
 * send is attempted and the notification row stays 'logged' (fail-closed,
 * honest). A PARTIAL AT pair (key without username or vice versa) resolves to
 * null, not to a provider that will 401 on every send — fail closed.
 */
export function getSmsProvider(env: NodeJS.ProcessEnv = process.env): ChannelProvider | null {
  const url = (env.NOTIFY_SMS_WEBHOOK_URL ?? '').trim()
  if (url) {
    const token = (env.NOTIFY_SMS_WEBHOOK_TOKEN ?? '').trim()
    return new WebhookSmsProvider(url, token || undefined)
  }
  const apiKey = (env.AT_API_KEY ?? '').trim()
  const username = (env.AT_USERNAME ?? '').trim()
  if (apiKey && username) {
    const senderId = (env.AT_SENDER_ID ?? '').trim()
    const sandbox = (env.AT_ENV ?? '').trim().toLowerCase() === 'sandbox'
    return new AtSmsProvider(apiKey, username, senderId || undefined, sandbox ? AT_SANDBOX_BASE : AT_PROD_BASE)
  }
  return null
}

// Notifications module — external channel providers (the provider seam).
//
// The ChannelProvider interface is how notify() reaches people who are not
// staring at the app. SMS is wired today (WebhookSmsProvider); WhatsApp and
// email are future providers that implement the same interface and get
// resolved in service.ts — no new concepts needed.
//
// Honest by construction:
//   · A provider is only "configured" when its env is present — no URL, no
//     send; the notification row stays 'logged' (fail-closed, never fakes a
//     delivery).
//   · send() NEVER throws: every failure mode (timeout, non-2xx, network
//     error) comes back as { status: 'failed', detail } with an operator-
//     readable detail that leaks nothing internal — error CLASS only, never
//     stack traces or webhook URLs (fetch error messages can embed URLs).

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
 * The one wired provider today: a JSON POST to a generic SMS webhook.
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
 * Resolve the SMS provider from env, at call time. Returns null when
 * NOTIFY_SMS_WEBHOOK_URL is unset/blank → no external send is attempted and
 * the notification row stays 'logged' (fail-closed, honest).
 */
export function getSmsProvider(env: NodeJS.ProcessEnv = process.env): ChannelProvider | null {
  const url = (env.NOTIFY_SMS_WEBHOOK_URL ?? '').trim()
  if (!url) return null
  const token = (env.NOTIFY_SMS_WEBHOOK_TOKEN ?? '').trim()
  return new WebhookSmsProvider(url, token || undefined)
}

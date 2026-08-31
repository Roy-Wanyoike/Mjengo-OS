/*
 * Analytics abstraction — provider-agnostic by design.
 *
 * Usage:  track("hero_cta_clicked", { cta: "start_project" })
 *
 * Behaviour:
 *  - If NEXT_PUBLIC_ANALYTICS_ENDPOINT is set, events are sent there as JSON
 *    via sendBeacon (non-blocking) — wire it to any collector you like.
 *  - If unset, events are logged to the console in development only.
 *  - No analytics provider is contacted otherwise. No cookies. No PII.
 */

export type AnalyticsEvent =
  | "page_viewed"
  | "hero_cta_clicked"
  | "platform_viewed"
  | "land_verification_viewed"
  | "marketplace_viewed"
  | "wallet_viewed"
  | "ai_viewed"
  | "pricing_viewed"
  | "contact_submitted"
  | "signup_started"
  | "signup_completed"
  | "demo_requested"
  | (string & {});

interface Payload {
  event: string;
  props?: Record<string, unknown>;
  ts: string;
  url: string;
}

const ENDPOINT = process.env.NEXT_PUBLIC_ANALYTICS_ENDPOINT;
const isDev = process.env.NODE_ENV !== "production";

/** Route → canonical "page viewed" event mapping. */
const ROUTE_EVENTS: Record<string, string> = {
  "/": "page_viewed",
  "/platform": "platform_viewed",
  "/land-verification": "land_verification_viewed",
  "/marketplace": "marketplace_viewed",
  "/materials": "marketplace_viewed",
  "/wallet": "wallet_viewed",
  "/ai": "ai_viewed",
  "/pricing": "pricing_viewed",
};

export function track(event: AnalyticsEvent, props?: Record<string, unknown>): void {
  if (typeof window === "undefined") return;

  const payload: Payload = {
    event,
    props,
    ts: new Date().toISOString(),
    url: window.location.pathname,
  };

  if (ENDPOINT && typeof navigator.sendBeacon === "function") {
    try {
      navigator.sendBeacon(ENDPOINT, new Blob([JSON.stringify(payload)], { type: "application/json" }));
    } catch {
      // A failed analytics beacon must never break the site.
    }
  } else if (isDev) {
    console.debug("[analytics]", payload.event, props ?? "");
  }
}

/** Fire the canonical page event for a route (used by PageAnalytics). */
export function trackRoute(pathname: string): void {
  const event = ROUTE_EVENTS[pathname] ?? "page_viewed";
  track(event, { path: pathname });
}

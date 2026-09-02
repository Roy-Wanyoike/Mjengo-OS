"use client";

import { useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { track } from "@/lib/analytics";

/**
 * Link to the actual MjengoOS application ("Sign in") — the login connector
 * between the marketing website and the web app.
 *
 * Resolution order:
 * 1. NEXT_PUBLIC_APP_URL (standalone deployments, e.g. https://app.mjengoos.com)
 * 2. Direct local dev (website served from localhost:3001) → the web app's
 *    dev server at http://localhost:3000
 * 3. Otherwise "/" — behind the single-origin sandbox gateway the app lives
 *    at the bare "/" (the website is previewed with ?XTransformPort=3001;
 *    Sign in strips that parameter so the gateway routes to the app on :3000).
 *
 * The href is resolved via useSyncExternalStore (server snapshot: "/") which
 * keeps SSR and first client render consistent — no hydration mismatch.
 */

const APP_URL_ENV = process.env.NEXT_PUBLIC_APP_URL;

function appHrefFromLocation(): string {
  if (APP_URL_ENV && APP_URL_ENV !== "/") return APP_URL_ENV;
  if (typeof window !== "undefined") {
    const { hostname, port } = window.location;
    // Direct local dev: `bun run dev` serves the website on :3001 and the
    // web app on :3000 — a bare "/" would loop back to the website itself.
    if ((hostname === "localhost" || hostname === "127.0.0.1") && port === "3001") {
      return "http://localhost:3000";
    }
  }
  // Same-origin gateway (or same-origin deployment): the app is at "/".
  return "/";
}

function subscribeLocation(callback: () => void) {
  window.addEventListener("popstate", callback);
  return () => window.removeEventListener("popstate", callback);
}

export function AppLink({
  children,
  className,
  trackEvent,
}: {
  children: ReactNode;
  className?: string;
  trackEvent?: string;
}) {
  const href = useSyncExternalStore(
    subscribeLocation,
    appHrefFromLocation,
    () => (APP_URL_ENV && APP_URL_ENV !== "/" ? APP_URL_ENV : "/"),
  );

  return (
    <a
      href={href}
      className={cn("inline-flex items-center gap-1.5", className)}
      onClick={() => {
        if (trackEvent) track(trackEvent);
      }}
    >
      {children}
    </a>
  );
}

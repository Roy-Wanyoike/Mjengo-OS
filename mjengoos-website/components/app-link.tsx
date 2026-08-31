"use client";

import { useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { track } from "@/lib/analytics";

/**
 * Link to the actual MjengoOS application ("Sign in").
 *
 * Behind the sandbox gateway the app is the same host at the bare "/" (no
 * XTransformPort query) — so we strip the parameter. Standalone deployments
 * use NEXT_PUBLIC_APP_URL (e.g. https://app.mjengoos.com).
 */
function useAppHref(): string {
  const env = process.env.NEXT_PUBLIC_APP_URL;
  return useSyncExternalStore(
    subscribeLocation,
    () => {
      if (env && env !== "/") return env;
      // Same host, no port parameter → gateway routes to the app on :3000.
      return "/";
    },
    () => env && env !== "/" ? env : "/",
  );
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
  const href = useAppHref();

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

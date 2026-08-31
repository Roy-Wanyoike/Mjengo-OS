"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSyncExternalStore, type ReactNode } from "react";
import { withGatewayPort } from "@/lib/utils";
import { cn } from "@/lib/utils";

/**
 * Internal link that transparently preserves the gateway's XTransformPort
 * query parameter. When the site is previewed through the sandbox gateway
 * (`?XTransformPort=3001`), every internal navigation keeps that parameter
 * so the gateway keeps routing to the website. Standalone deployments are
 * unaffected — links render as plain relative hrefs.
 *
 * The parameter is read via useSyncExternalStore (server snapshot: null),
 * which keeps SSR and first client render identical — no hydration mismatch.
 */
function useGatewayPort(): string | null {
  return useSyncExternalStore(
    subscribeLocation,
    () => new URLSearchParams(window.location.search).get("XTransformPort"),
    () => null,
  );
}

function subscribeLocation(callback: () => void) {
  window.addEventListener("popstate", callback);
  return () => window.removeEventListener("popstate", callback);
}

export function SiteLink({
  href,
  children,
  className,
  onClick,
  ariaLabel,
  ...rest
}: {
  href: string;
  children: ReactNode;
  className?: string;
  onClick?: React.MouseEventHandler<HTMLAnchorElement>;
  ariaLabel?: string;
  prefetch?: boolean;
}) {
  const port = useGatewayPort();
  const finalHref = withGatewayPort(href, port);

  return (
    <Link href={finalHref} className={cn(className)} onClick={onClick} aria-label={ariaLabel} prefetch={rest.prefetch}>
      {children}
    </Link>
  );
}

/**
 * Active-state-aware SiteLink for nav menus.
 */
export function NavLink({
  href,
  children,
  className,
  onClick,
}: {
  href: string;
  children: ReactNode;
  className?: string;
  onClick?: React.MouseEventHandler<HTMLAnchorElement>;
}) {
  const pathname = usePathname();
  const port = useGatewayPort();
  const active = pathname === href || (href !== "/" && pathname.startsWith(href + "/"));

  return (
    <Link
      href={withGatewayPort(href, port)}
      aria-current={active ? "page" : undefined}
      className={cn("transition-colors duration-150", active ? "text-forest-800 font-semibold" : "text-ink-mute hover:text-ink", className)}
      onClick={onClick}
    >
      {children}
    </Link>
  );
}

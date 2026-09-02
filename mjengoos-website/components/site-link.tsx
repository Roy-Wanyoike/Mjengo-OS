"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { withGatewayPort } from "@/lib/utils";
import { cn } from "@/lib/utils";

/**
 * Internal link that transparently preserves the gateway's XTransformPort
 * query parameter. When the site is previewed through the sandbox gateway
 * (`?XTransformPort=3001`), every internal navigation keeps that parameter
 * so the gateway keeps routing to the website. Standalone deployments are
 * unaffected — links render as plain relative hrefs.
 *
 * The parameter is read in an effect after mount: SSR and the first client
 * render show the param-less href (no hydration mismatch), then links
 * re-render with the parameter preserved. Because every internal link then
 * carries the parameter, App Router client navigations keep it in the URL
 * — the store only needs to re-read on mount and on back/forward (popstate).
 */
function useGatewayPort(): string | null {
  const [port, setPort] = useState<string | null>(null);

  useEffect(() => {
    const read = () =>
      setPort(new URLSearchParams(window.location.search).get("XTransformPort"));
    read(); // post-hydration sync — SSR rendered with port=null
    window.addEventListener("popstate", read);
    return () => window.removeEventListener("popstate", read);
  }, []);

  return port;
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

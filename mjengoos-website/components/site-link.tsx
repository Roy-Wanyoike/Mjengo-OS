"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { withGatewayPort } from "@/lib/utils";
import { useGatewayPort } from "@/lib/use-gateway-port";
import { cn } from "@/lib/utils";

/**
 * Internal link that transparently preserves the gateway's XTransformPort
 * query parameter across navigation (see `lib/use-gateway-port.ts` for how
 * the sandbox preview routing works). Standalone deployments are
 * unaffected — links render as plain relative hrefs.
 */
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

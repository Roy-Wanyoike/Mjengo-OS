import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Merge conditional class names with Tailwind-aware deduplication. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Format a number as KES currency, e.g. 4200000 → "KES 4,200,000". */
export function formatKES(amount: number): string {
  return `KES ${amount.toLocaleString("en-KE")}`;
}

/** Safely join a base href with the gateway port parameter (see SiteLink). */
export function withGatewayPort(href: string, port: string | null): string {
  if (!port || !href.startsWith("/")) return href;
  const separator = href.includes("?") ? "&" : "?";
  return `${href}${separator}XTransformPort=${encodeURIComponent(port)}`;
}

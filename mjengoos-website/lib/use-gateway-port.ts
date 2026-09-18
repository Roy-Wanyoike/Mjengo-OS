"use client";

import { useEffect, useState } from "react";

/**
 * Gateway preview-port reader — the shared substrate behind every internal
 * link on the site (`SiteLink`/`NavLink` for nav and footer, `Button` for
 * every CTA, and the 404 page).
 *
 * When the site is previewed through the sandbox gateway
 * (`?XTransformPort=3001`), every internal navigation must keep that
 * parameter so the gateway keeps routing to this website — a request
 * without it falls through to the default app on port 3000. The parameter
 * is read in an effect after mount: SSR and the first client render see
 * `null` (links render param-less — no hydration mismatch), then links
 * re-render with the parameter preserved. Because every internal link then
 * carries the parameter, App Router client navigations keep it in the URL
 * — the hook only needs to re-read on mount and on back/forward
 * (popstate). Standalone and integrated (`/website` proxy) deployments
 * never carry the parameter, so links there stay plain relative hrefs.
 */
export function useGatewayPort(): string | null {
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

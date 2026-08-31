"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { trackRoute } from "@/lib/analytics";

/** Fires the canonical analytics event for the current route. */
export function PageAnalytics() {
  const pathname = usePathname();

  useEffect(() => {
    trackRoute(pathname);
  }, [pathname]);

  return null;
}

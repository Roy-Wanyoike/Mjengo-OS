import type { MetadataRoute } from "next";
import { SITE } from "@/lib/site";

/**
 * robots.txt — the sitemap URL joins the canonical origin with the serving
 * base path (MW-9): under the /website proxy the sitemap is reachable at
 * https://host/website/sitemap.xml, and that is what crawlers must be told.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: "/", disallow: ["/api/"] },
    sitemap: `${SITE.url}${SITE.basePath}/sitemap.xml`,
  };
}

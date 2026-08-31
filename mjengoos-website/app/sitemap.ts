import type { MetadataRoute } from "next";
import { SITE } from "@/lib/site";

export default function sitemap(): MetadataRoute.Sitemap {
  const routes = [
    { path: "", priority: 1.0 },
    { path: "/platform", priority: 0.9 },
    { path: "/solutions", priority: 0.8 },
    { path: "/solutions/client", priority: 0.7 },
    { path: "/solutions/site-supervisors", priority: 0.7 },
    { path: "/solutions/contractors", priority: 0.7 },
    { path: "/solutions/professionals", priority: 0.7 },
    { path: "/solutions/suppliers", priority: 0.7 },
    { path: "/solutions/finance", priority: 0.7 },
    { path: "/land-verification", priority: 0.9 },
    { path: "/professionals", priority: 0.8 },
    { path: "/materials", priority: 0.8 },
    { path: "/marketplace", priority: 0.8 },
    { path: "/wallet", priority: 0.8 },
    { path: "/ai", priority: 0.8 },
    { path: "/projects", priority: 0.8 },
    { path: "/pricing", priority: 0.8 },
    { path: "/about", priority: 0.6 },
    { path: "/contact", priority: 0.7 },
    { path: "/signup", priority: 0.9 },
    { path: "/resources", priority: 0.6 },
    { path: "/security", priority: 0.6 },
    { path: "/privacy", priority: 0.4 },
    { path: "/terms", priority: 0.4 },
  ];

  return routes.map((r) => ({
    url: `${SITE.url}${r.path}`,
    lastModified: new Date(),
    changeFrequency: "monthly" as const,
    priority: r.priority,
  }));
}

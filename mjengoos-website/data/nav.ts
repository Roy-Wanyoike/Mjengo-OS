import type { NavItem } from "@/types";

/** Primary desktop/mobile navigation (§11 of the brief). */
export const NAV_ITEMS: NavItem[] = [
  { label: "Platform", href: "/platform" },
  { label: "Solutions", href: "/solutions" },
  { label: "Land", href: "/land-verification" },
  { label: "Marketplace", href: "/marketplace" },
  { label: "Wallet", href: "/wallet" },
  { label: "AI", href: "/ai" },
  { label: "Resources", href: "/resources" },
];

/** Footer link columns (§36). */
export const FOOTER_COLUMNS: { title: string; items: NavItem[] }[] = [
  {
    title: "Platform",
    items: [
      { label: "Platform overview", href: "/platform" },
      { label: "Solutions", href: "/solutions" },
      { label: "Land Verification", href: "/land-verification" },
      { label: "Professionals", href: "/professionals" },
      { label: "Marketplace", href: "/marketplace" },
      { label: "Wallet", href: "/wallet" },
      { label: "AI", href: "/ai" },
    ],
  },
  {
    title: "Resources",
    items: [
      { label: "Resources", href: "/resources" },
      { label: "Projects", href: "/projects" },
      { label: "Pricing", href: "/pricing" },
      { label: "Contact", href: "/contact" },
    ],
  },
  {
    title: "Company",
    items: [
      { label: "About", href: "/about" },
      { label: "Security", href: "/security" },
    ],
  },
  {
    title: "Legal",
    items: [
      { label: "Privacy", href: "/privacy" },
      { label: "Terms", href: "/terms" },
    ],
  },
];

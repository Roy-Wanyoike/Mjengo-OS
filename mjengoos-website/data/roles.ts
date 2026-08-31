import type { RoleDefinition } from "@/types";

/**
 * The nine roles of the MjengoOS role-based experience (§30).
 * Used by the homepage RoleSwitcher, /solutions index and /solutions/[slug].
 */
export const ROLES: RoleDefinition[] = [
  {
    slug: "client",
    name: "Client",
    icon: "Building",
    oneLiner: "Know what is happening, without being on site.",
    description:
      "You are funding the project — maybe from Nairobi, maybe from Dubai. MjengoOS gives you the same view the site team has: progress backed by photos, budget backed by records, and approvals that wait for you, not for a phone call.",
    modules: ["Progress", "Budget", "Photos", "Milestones", "Approvals", "Alerts"],
    preview: [
      { title: "Build progress", value: "68%", hint: "photo-verified" },
      { title: "Budget used", value: "54%", hint: "KES 2.3M of 4.2M" },
      { title: "New photos today", value: "5", hint: "with GPS + timestamps" },
      { title: "Awaiting your approval", value: "2", hint: "milestone + invoice" },
    ],
    pains: [
      "Progress reports arrive as screenshots and promises.",
      "Money leaves your account and vanishes into the build.",
      "You find out about problems months after they happened.",
    ],
    gains: [
      "Every progress claim is anchored to dated, geolocated site photos.",
      "Escrow-style milestone releases — you approve before money moves.",
      "Alerts surface anomalies early, when they are still cheap to fix.",
    ],
  },
  {
    slug: "site-supervisors",
    name: "Site Supervisor",
    icon: "ClipboardCheck",
    oneLiner: "Run the site from your pocket, online or off.",
    description:
      "Muster workers, capture evidence, log deliveries and file the daily report — even with zero network on site. MjengoOS syncs when connectivity returns, and workers don't need smartphones of their own.",
    modules: ["Workers", "Attendance", "Tasks", "Deliveries", "Daily Report", "Site Issues"],
    preview: [
      { title: "Workers on muster", value: "27", hint: "24 present · 2 late · 1 absent" },
      { title: "Attendance method", value: "PIN", hint: "no smartphones needed" },
      { title: "Deliveries today", value: "3", hint: "logged with photos" },
      { title: "Daily report", value: "Draft", hint: "auto-assembled" },
    ],
    pains: [
      "Attendance is a paper book and disputes are endless.",
      "Photos and notes live in five different WhatsApp groups.",
      "The daily report takes an hour nobody has.",
    ],
    gains: [
      "Worker PIN attendance — captured in seconds, even offline.",
      "One place for photos, deliveries, issues and the daily record.",
      "The day's evidence assembles itself into the report.",
    ],
  },
  {
    slug: "contractors",
    name: "Contractor",
    icon: "HardHat",
    oneLiner: "One project. One source of truth. Fewer arguments.",
    description:
      "Plan the build, raise variations, manage procurement and workers, and invoice against evidence. MjengoOS records every decision — so the record, not memory, settles disagreements.",
    modules: ["Projects", "BOQ", "Procurement", "Workers", "Invoices", "Variations", "Payments"],
    preview: [
      { title: "Active projects", value: "3", hint: "KES 11.4M pipeline" },
      { title: "Variations pending", value: "2", hint: "KES 214,000 impact" },
      { title: "Invoices awaiting client", value: "3", hint: "evidence attached" },
      { title: "Muster today", value: "62", hint: "across all sites" },
    ],
    pains: [
      "Scope creep erodes margin and nobody can prove when it started.",
      "Invoices wait weeks because proof of work is scattered.",
      "Procurement decisions leave no trail.",
    ],
    gains: [
      "Variations documented, submitted and decided — with a trail.",
      "Invoices that carry their own evidence get approved faster.",
      "The full procurement chain, from BOQ to delivery, in one ledger.",
    ],
  },
  {
    slug: "professionals",
    name: "Professional",
    icon: "DraftingCompass",
    oneLiner: "Surveyors, architects, engineers, QS — attached to the project.",
    description:
      "Your licence and your work, connected. MjengoOS lets verified professionals receive assignments, publish reports and attach evidence to the projects they are part of — building a public track record.",
    modules: ["Assignments", "Reports", "Evidence", "Verification", "Ratings", "Service Area"],
    preview: [
      { title: "Verification", value: "Licence checked", hint: "LSK / EBK / BORAQS" },
      { title: "Active assignments", value: "4", hint: "2 surveys · 2 reviews" },
      { title: "Reports published", value: "18", hint: "attached to projects" },
      { title: "Service area", value: "Nairobi + Kiambu", hint: "counties covered" },
    ],
    pains: [
      "Credentials are taken on trust; anyone can claim anything.",
      "Reports vanish into email threads after delivery.",
      "Good work builds no reputation.",
    ],
    gains: [
      "Professional verification — licence details on record, not on trust.",
      "Reports and survey evidence attached permanently to the project.",
      "A track record clients can actually inspect.",
    ],
  },
  {
    slug: "suppliers",
    name: "Supplier",
    icon: "Truck",
    oneLiner: "Reach sites at the moment they need materials.",
    description:
      "List products and stock, respond to quote requests, deliver against purchase orders with photo proof of delivery. MjengoOS connects the region's hardware stores and warehouses to active projects.",
    modules: ["Products", "Stock", "Quotes", "Orders", "Deliveries", "Payments"],
    preview: [
      { title: "Quote requests", value: "7", hint: "this week" },
      { title: "Open orders", value: "12", hint: "delivery slots set" },
      { title: "Deliveries verified", value: "31", hint: "photo-confirmed" },
      { title: "Region", value: "Nairobi", hint: "warehouse + delivery" },
    ],
    pains: [
      "Demand arrives as phone calls with no paper trail.",
      "Payment follows delivery by weeks.",
      "Nobody knows what you actually stock.",
    ],
    gains: [
      "Quote requests arrive structured — material, quantity, date needed.",
      "Deliveries confirmed with photos close the loop immediately.",
      "Your stock and prices visible to the projects that need them.",
    ],
  },
  {
    slug: "finance",
    name: "Finance",
    icon: "Wallet",
    oneLiner: "Every shilling has a story.",
    description:
      "Budgets, commitments, payments and reconciliation in one financial record — tied to the physical evidence that justifies them. For funders and finance teams who need the trail, not just the total.",
    modules: ["Wallet", "Budget", "Approvals", "Payments", "Reconciliation", "Audit"],
    preview: [
      { title: "Project wallet", value: "KES 4.2M", hint: "1.84M available" },
      { title: "Committed", value: "KES 1.2M", hint: "against milestones" },
      { title: "Audit events", value: "1,284", hint: "append-only ledger" },
      { title: "Payment method", value: "M-Pesa", hint: "reference on record" },
    ],
    pains: [
      "Reconciliation means chasing receipts across WhatsApp and notebooks.",
      "Approvals happen verbally and are remembered differently.",
      "Disputes have no shared record to land on.",
    ],
    gains: [
      "One wallet per project: available, committed and spent — always current.",
      "Approvals recorded with actor, timestamp and note.",
      "An append-only audit ledger of every financial action.",
    ],
  },
];

/** Compact role list for the interactive homepage switcher (§30). */
export const SWITCHER_ROLES = [
  ...ROLES.map((r) => ({ slug: r.slug, name: r.name, modules: r.modules, preview: r.preview })),
  {
    slug: "admin",
    name: "Admin",
    modules: ["Portfolio", "Users", "Policies", "Audit", "Integrations"],
    preview: [
      { title: "Portfolio", value: "3 projects", hint: "all companies" },
      { title: "Users", value: "12", hint: "roles + access" },
      { title: "Audit ledger", value: "Append-only", hint: "every action logged" },
      { title: "Policy", value: "Role-based", hint: "least privilege" },
    ],
  },
] satisfies {
  slug: string;
  name: string;
  modules: string[];
  preview: { title: string; value: string; hint?: string }[];
}[];

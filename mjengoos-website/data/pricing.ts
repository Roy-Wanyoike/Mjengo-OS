import type { PricingTier, FaqItem } from "@/types";

/**
 * Honest early-access pricing (§49): no invented enterprise tiers with fake
 * volume discounts. Real plan: free during early access, transparent about
 * what comes after.
 */
export const PRICING_TIERS: PricingTier[] = [
  {
    name: "Early Access",
    price: "Free",
    period: "during pilot",
    tagline: "For the first projects building on MjengoOS.",
    features: [
      "Full platform — all modules",
      "Up to 3 active projects",
      "Unlimited team members per project",
      "Offline capture & sync",
      "Direct line to the product team",
      "Your feedback shapes the roadmap",
    ],
    cta: { label: "Request access", href: "/signup" },
    highlight: true,
    footnote: "We're onboarding projects in Nairobi & Kiambu first.",
  },
  {
    name: "Team",
    price: "KES 15,000",
    period: "per project / month",
    tagline: "Post-pilot pricing for active construction projects.",
    features: [
      "Everything in Early Access",
      "Unlimited active projects",
      "Supplier marketplace participation",
      "AI photo & voice analysis included",
      "Audit ledger export",
      "Priority support",
    ],
    cta: { label: "Talk to us", href: "/contact" },
    footnote: "Indicative — final pricing will be published before the pilot ends. Pilot projects keep their terms.",
  },
  {
    name: "Portfolio",
    price: "Custom",
    period: "for funders & firms",
    tagline: "Multiple concurrent projects, portfolios and integrations.",
    features: [
      "Multi-project portfolio view",
      "Funder & finance-team surfaces",
      "Reconciliation exports",
      "Integration access (API)",
      "Dedicated onboarding",
    ],
    cta: { label: "Contact sales", href: "/contact" },
    footnote: "For development funds, SACCOs, housing co-ops and construction firms.",
  },
];

export const PRICING_FAQS: FaqItem[] = [
  {
    question: "What happens when the free pilot ends?",
    answer:
      "Pilot projects keep their Early Access terms for the life of those projects. New projects move to published pricing — which we will announce well in advance, with no surprises locked inside your data.",
  },
  {
    question: "Does the wallet hold my money?",
    answer:
      "No. MjengoOS is not a bank and holds no deposits. The project wallet is a ledger: it records commitments, approvals, payments and their references so every shilling has a traceable story.",
  },
  {
    question: "Can I export my project data?",
    answer:
      "Yes. Your project's record — photos, ledger, reports, audit trail — is yours. Export is built into the platform, not held hostage behind a plan.",
  },
  {
    question: "Do workers need smartphones or accounts?",
    answer:
      "No. Workers are managed from the supervisor's device with PIN attendance. Only supervisory and office roles need accounts.",
  },
  {
    question: "What about sites with no internet?",
    answer:
      "That's the design centre, not an edge case. Attendance, photos, deliveries and daily reports capture offline on the device and sync when any connection returns.",
  },
  {
    question: "How do you handle payments?",
    answer:
      "M-Pesa references are recorded against payments — the reference code, timestamp and actor go into the ledger. MjengoOS records payments; it does not move them.",
  },
];

import type { Metadata } from "next";
import { PageHero } from "@/components/page-hero";
import { CapabilitiesGrid } from "./components/capabilities-grid";
import { GovernanceBand } from "./components/governance-band";
import { AfricaBuilt } from "./components/africa-built";
import { AiCtaBand } from "./components/cta-band";

export const metadata: Metadata = {
  title: "AI",
  description:
    "AI that works with your project data. Photo progress analysis, Swahili voice notes turned into structured records, document and plan intelligence, and anomaly detection — advisory by design, with human review on every high-risk path. Built for African sites.",
  alternates: { canonical: "/ai" },
};

/**
 * /ai — the AI layer deep-dive: the four capabilities (SEE / LISTEN /
 * UNDERSTAND / DETECT) as full mockups, the governance band, the
 * built-for-African-sites grid and the CTA.
 */
export default function AiPage() {
  return (
    <>
      <PageHero
        eyebrow="AI, grounded"
        title="AI that works with your project data."
        description="The intelligence layer runs on what your site actually produced — photos, voice notes, deliveries, budgets. AI amplifies the record; it never replaces the people accountable for it."
      />

      <CapabilitiesGrid />
      <GovernanceBand />
      <AfricaBuilt />
      <AiCtaBand />
    </>
  );
}

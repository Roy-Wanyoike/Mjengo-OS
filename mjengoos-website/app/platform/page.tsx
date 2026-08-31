import type { Metadata } from "next";
import { ArrowRight } from "lucide-react";
import { PageHero } from "@/components/page-hero";
import { Button } from "@/components/button";
import { ModuleGrid } from "./components/module-grid";
import { ModuleChain } from "./components/module-chain";
import { EvidenceDeepDive } from "./components/evidence-deep-dive";
import { ApprovalsDeepDive } from "./components/approvals-deep-dive";
import { OfflineDeepDive } from "./components/offline-deep-dive";
import { PlatformCTA } from "./components/platform-cta";

export const metadata: Metadata = {
  title: "Platform",
  description:
    "Every module. One record. Land verification, professionals, project management & BOQ, workers & attendance, materials & procurement, wallet & payments, evidence capture, AI assistance, offline sync and role-based access — the complete MjengoOS platform.",
  alternates: { canonical: "/platform" },
};

/**
 * /platform — the complete platform tour: hero, the ten-module grid, the
 * money-path chain, three deep dives (evidence, approvals, offline) and CTA.
 */
export default function PlatformPage() {
  return (
    <>
      <PageHero
        eyebrow="Platform"
        title="Every module. One record."
        description="MjengoOS connects land, professionals, planning, workers, materials, money and evidence into a single project record — every module writing to the same source of truth, from the first registry search to the final approved payment."
        actions={
          <>
            <Button href="/signup" size="lg">
              Start a Project
              <ArrowRight className="h-4 w-4" aria-hidden />
            </Button>
            <Button href="/pricing" size="lg" variant="ghost">
              View pricing
            </Button>
          </>
        }
      />

      <ModuleGrid />
      <ModuleChain />
      <EvidenceDeepDive />
      <ApprovalsDeepDive />
      <OfflineDeepDive />
      <PlatformCTA />
    </>
  );
}

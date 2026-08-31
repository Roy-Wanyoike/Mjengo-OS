import type { Metadata } from "next";
import { PageHero } from "@/components/page-hero";
import { VerificationWorkflow } from "./components/verification-workflow";
import { PropertyPassport } from "./components/property-passport";
import { ProfessionalNetwork } from "./components/professional-network";
import { HonestyBlock } from "./components/honesty-block";
import { LandCtaBand } from "./components/cta-band";

export const metadata: Metadata = {
  title: "Land Verification",
  description:
    "Before you build, know what you're building on. MjengoOS organizes the land verification workflow — documents, official search, survey, inspection, legal review — connects you with verified professionals, and records it all in a Property Passport. Not a government certificate.",
  alternates: { canonical: "/land-verification" },
};

/**
 * /land-verification — deepens the homepage section: the five-stage
 * workflow with the honest state ladder, a richer Property Passport,
 * the verified-professional band, an explicit "what we do not do" block
 * and the CTA. Honest throughout: no government verification claims.
 */
export default function LandVerificationPage() {
  return (
    <>
      <PageHero
        eyebrow="Land verification"
        title="Before you build, know what you're building on."
        description="Most construction disputes begin before the foundation. MjengoOS organizes the verification workflow — documents, official search, survey, inspection, legal review — connects you with verified professionals, and records the state of the land in a Property Passport your whole team can read."
      />

      <VerificationWorkflow />
      <PropertyPassport />
      <ProfessionalNetwork />
      <HonestyBlock />
      <LandCtaBand />
    </>
  );
}

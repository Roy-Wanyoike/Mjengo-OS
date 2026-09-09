import type { Metadata } from "next";
import { PageHero } from "@/components/page-hero";
import { ProfessionalTypes } from "./components/professional-types";
import { VerificationSteps } from "./components/verification-steps";
import { ProfessionalBenefits } from "./components/professional-benefits";
import { DirectoryPreview } from "./components/directory-preview";
import { ProfessionalsCtaBand } from "./components/cta-band";

export const metadata: Metadata = {
  title: "Professionals",
  description:
    "A professional network being built, not a finished directory — join as one of the first. Licensed surveyors, architects, engineers, quantity surveyors and contractors connected to MjengoOS projects; licence documents reviewed, issuing-body references recorded, reports published to the project record.",
  alternates: { canonical: "/professionals" },
};

/**
 * /professionals — the professional network, honestly staged as being built:
 * type grid with real Kenyan credential bodies, the honest four-step
 * verification, benefits, a directory preview mockup (illustrative) and
 * the CTA to join as one of the first.
 */
export default function ProfessionalsPage() {
  return (
    <>
      <PageHero
        eyebrow="Professional network"
        title="A network being built — join as one of the first."
        description="Surveyors, architects, engineers, quantity surveyors, contractors — licensed in Kenya, licence documents reviewed at onboarding, their work landing where the project needs it: in the record. There is no live directory yet: joining now means being one of the first profiles in it."
      />

      <ProfessionalTypes />
      <VerificationSteps />
      <ProfessionalBenefits />
      <DirectoryPreview />
      <ProfessionalsCtaBand />
    </>
  );
}

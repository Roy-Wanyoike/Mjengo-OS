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
    "A verified network of licensed surveyors, architects, engineers, quantity surveyors and contractors, connected to MjengoOS projects. Licence documents reviewed, issuing-body references recorded, reports published to the project record.",
  alternates: { canonical: "/professionals" },
};

/**
 * /professionals — the verified network: type grid with real Kenyan
 * credential bodies, the honest four-step verification, benefits,
 * a directory preview mockup and the CTA.
 */
export default function ProfessionalsPage() {
  return (
    <>
      <PageHero
        eyebrow="Professional network"
        title="Trusted professionals, connected to the project."
        description="Surveyors, architects, engineers, quantity surveyors, contractors — licensed in Kenya, licence documents reviewed, their work landing where the project needs it: in the record."
      />

      <ProfessionalTypes />
      <VerificationSteps />
      <ProfessionalBenefits />
      <DirectoryPreview />
      <ProfessionalsCtaBand />
    </>
  );
}

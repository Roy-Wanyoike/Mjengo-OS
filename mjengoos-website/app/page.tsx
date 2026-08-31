import type { Metadata } from "next";
import { Hero } from "@/sections/hero";
import { TrustStrip } from "@/sections/trust-strip";
import { Problem } from "@/sections/problem";
import { Ecosystem } from "@/sections/ecosystem";
import { GroundTruth } from "@/sections/ground-truth";
import { RemoteMonitoring } from "@/sections/remote-monitoring";
import { LandVerification } from "@/sections/land-verification";
import { ProjectManagement } from "@/sections/project-management";
import { Workers } from "@/sections/workers";
import { MaterialsMarketplace } from "@/sections/materials-marketplace";
import { Procurement } from "@/sections/procurement";
import { Wallet } from "@/sections/wallet";
import { AI } from "@/sections/ai";
import { Offline } from "@/sections/offline";
import { Roles } from "@/sections/roles";
import { HowItWorks } from "@/sections/how-it-works";
import { Timeline } from "@/sections/timeline";
import { TrustMatrix } from "@/sections/trust-matrix";
import { CTA } from "@/sections/cta";
import { SITE } from "@/lib/site";

export const metadata: Metadata = {
  title: "MjengoOS — Build with evidence.",
  description: SITE.description,
  alternates: { canonical: "/" },
};

/**
 * Homepage — composed from the 17 section components (§10).
 */
export default function HomePage() {
  return (
    <>
      <Hero />
      <TrustStrip />
      <Problem />
      <Ecosystem />
      <GroundTruth />
      <RemoteMonitoring />
      <LandVerification />
      <ProjectManagement />
      <Workers />
      <MaterialsMarketplace />
      <Procurement />
      <Wallet />
      <AI />
      <Offline />
      <Roles />
      <HowItWorks />
      <Timeline />
      <TrustMatrix />
      <CTA />
    </>
  );
}

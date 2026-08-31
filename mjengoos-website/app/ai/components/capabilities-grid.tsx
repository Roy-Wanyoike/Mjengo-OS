import { PageSection } from "@/components/page-hero";
import { SectionHeading } from "@/components/section-heading";
import { CapabilitySee } from "./capability-see";
import { CapabilityListen } from "./capability-listen";
import { CapabilityUnderstand } from "./capability-understand";
import { CapabilityDetect } from "./capability-detect";

/**
 * /ai — the four capabilities as a 2×2 deep-dive grid (§26-29).
 * Each capability is a full mockup: SEE (photo comparison), LISTEN
 * (voice → record), UNDERSTAND (document intelligence), DETECT (anomaly).
 */
export function CapabilitiesGrid() {
  return (
    <PageSection tone="paper" ariaLabel="The four AI capabilities">
      <SectionHeading
        eyebrow="Four capabilities"
        title="Reads the site. Listens to the team. Checks the paperwork."
        description="The intelligence layer runs on what your project actually produced — photos, voice notes, deliveries, budgets. Each capability ends the same way: with a draft or a flag, waiting for a human."
      />

      <div className="mt-10 grid gap-6 lg:grid-cols-2">
        <CapabilitySee />
        <CapabilityListen />
        <CapabilityUnderstand />
        <CapabilityDetect />
      </div>
    </PageSection>
  );
}

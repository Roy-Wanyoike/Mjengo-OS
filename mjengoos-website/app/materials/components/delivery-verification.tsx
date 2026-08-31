import { Camera, ClipboardCheck, FileCheck2, ChevronRight } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { PageSection } from "@/components/page-hero";
import { SectionHeading } from "@/components/section-heading";
import { Reveal } from "@/components/reveal";
import { Badge } from "@/components/badge";

/**
 * /materials — the delivery verification band: gate photo → inspection
 * count → invoice matching. A compact chain, dark-toned for weight (§24).
 */
const CHAIN: { icon: LucideIcon; label: string; note: string }[] = [
  { icon: Camera, label: "Gate photo", note: "the truck, on site, at delivery time" },
  { icon: ClipboardCheck, label: "Inspection count", note: "bags counted, grades checked" },
  { icon: FileCheck2, label: "Invoice matching", note: "line items matched to the order" },
];

export function DeliveryVerification() {
  return (
    <PageSection tone="forest" ariaLabel="Delivery verification">
      <div className="grid items-center gap-10 lg:grid-cols-[1fr_1.05fr] lg:gap-16">
        <SectionHeading
          dark
          eyebrow="Delivery verification"
          title="The trail earns its keep at the gate."
          description="A good price means nothing if 18 bags arrive against 20 ordered — or the invoice says 24. Verification at delivery is what makes the comparison honest in the first place."
        />

        <Reveal delay={120}>
          <div className="rounded-xl border border-forest-800 bg-forest-950/70 p-6">
            <ol className="flex flex-col gap-3 sm:flex-row sm:items-stretch" aria-label="Delivery verification chain">
              {CHAIN.map((step, i) => (
                <li key={step.label} className="flex flex-1 items-center gap-3 sm:flex-col sm:items-center sm:text-center">
                  <div className="flex flex-1 flex-col items-center gap-2 rounded-lg border border-forest-700 bg-forest-900/70 px-4 py-4 sm:flex-none">
                    <span className="flex h-10 w-10 items-center justify-center rounded-full bg-earth-500/15 text-earth-300 ring-1 ring-earth-500/40">
                      <step.icon className="h-5 w-5" aria-hidden />
                    </span>
                    <p className="font-display text-[15px] font-semibold text-forest-50">{step.label}</p>
                    <p className="text-[11.5px] leading-snug text-forest-300/75">{step.note}</p>
                  </div>
                  {i < CHAIN.length - 1 && (
                    <ChevronRight
                      className="h-4 w-4 shrink-0 rotate-90 text-forest-600 sm:rotate-0"
                      aria-hidden
                    />
                  )}
                </li>
              ))}
            </ol>

            <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-forest-800 pt-4">
              <p className="text-[12.5px] leading-relaxed text-forest-300/80">
                20 bags ordered · 20 counted at inspection · invoice matched — that is a delivery closed
                properly.
              </p>
              <Badge tone="dark" className="border-earth-500/40 bg-earth-500/15 text-earth-300">
                <span className="font-mono text-[10px] tracking-wider">GATE → LEDGER</span>
              </Badge>
            </div>
          </div>
        </Reveal>
      </div>
    </PageSection>
  );
}

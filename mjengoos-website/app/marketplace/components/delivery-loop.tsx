import { FileText, Truck, Camera, ClipboardCheck, Receipt, Wallet, ChevronRight } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { PageSection } from "@/components/page-hero";
import { SectionHeading } from "@/components/section-heading";
import { Reveal } from "@/components/reveal";

/**
 * /marketplace — the delivery verification loop, compact diagram:
 * Order → Dispatch → Gate photo → Inspection count → Invoice match →
 * Payment record. Dark band (§24).
 */
const LOOP: { icon: LucideIcon; label: string }[] = [
  { icon: FileText, label: "Order" },
  { icon: Truck, label: "Dispatch" },
  { icon: Camera, label: "Gate photo" },
  { icon: ClipboardCheck, label: "Inspection count" },
  { icon: Receipt, label: "Invoice match" },
  { icon: Wallet, label: "Payment record" },
];

export function DeliveryLoop() {
  return (
    <PageSection tone="forest" ariaLabel="The delivery verification loop">
      <SectionHeading
        dark
        eyebrow="The loop"
        title="Every order closes the same way."
        description="Six steps from committed to paid — each one leaving evidence a human can check. When a step disagrees with the next, that is not an inconvenience; that is the system working."
      />

      <Reveal delay={150} className="mt-12">
        <ol
          className="flex flex-wrap items-center justify-center gap-2 sm:gap-2.5"
          aria-label="Delivery verification loop: order, dispatch, gate photo, inspection count, invoice match, payment record"
        >
          {LOOP.map((step, i) => (
            <li key={step.label} className="flex items-center gap-2 sm:gap-2.5">
              <span className="flex items-center gap-2.5 rounded-lg border border-forest-700 bg-forest-950/70 px-3.5 py-2.5 transition-colors hover:border-forest-500 sm:px-4">
                <step.icon className="h-4.5 w-4.5 shrink-0 text-earth-300" aria-hidden />
                <span className="font-display text-[13.5px] font-semibold text-forest-50">{step.label}</span>
                <span className="font-mono text-[9.5px] font-bold tracking-[0.16em] text-forest-300/60">
                  {String(i + 1).padStart(2, "0")}
                </span>
              </span>
              {i < LOOP.length - 1 && (
                <ChevronRight className="h-3.5 w-3.5 shrink-0 text-forest-600" aria-hidden />
              )}
            </li>
          ))}
        </ol>
      </Reveal>

      <Reveal delay={220}>
        <p className="mx-auto mt-8 max-w-2xl text-center text-[14px] leading-relaxed text-forest-300/85">
          300 bags ordered · 300 dispatched · 300 counted at the gate · invoice for 300 · payment recorded
          with its M-Pesa reference. Any number that disagrees stops the loop and asks a human why.
        </p>
      </Reveal>
    </PageSection>
  );
}

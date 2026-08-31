import { Store, MessageSquareText, Scale, Route } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { PageSection } from "@/components/page-hero";
import { SectionHeading } from "@/components/section-heading";
import { Reveal } from "@/components/reveal";

/**
 * /materials — how pricing works: supplier listings → quote requests →
 * comparison → order with trail. Four numbered steps.
 */
const STEPS: { icon: LucideIcon; title: string; text: string }[] = [
  {
    icon: Store,
    title: "Supplier listings",
    text: "Suppliers list materials with indicative prices and current stock — refreshed as yards actually change.",
  },
  {
    icon: MessageSquareText,
    title: "Quote requests",
    text: "You send one request with real quantities, delivery location and deadline — not an open-ended enquiry.",
  },
  {
    icon: Scale,
    title: "Comparison",
    text: "Quotes return side by side: price, stock that can actually cover the order, and delivery timing.",
  },
  {
    icon: Route,
    title: "Order with trail",
    text: "The purchase order is issued and the trail begins — dispatch, gate photo, inspection, invoice, payment record.",
  },
];

export function PricingSteps() {
  return (
    <PageSection tone="paper" ariaLabel="How pricing works">
      <SectionHeading
        eyebrow="How pricing works"
        title="From listing to ledger, without the fog."
        description="Indicative listings narrow the field. Quotes set the real price. The trail keeps the deal honest after the handshake."
      />

      <ol className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4" aria-label="How pricing works, four steps">
        {STEPS.map((step, i) => (
          <Reveal as="li" key={step.title} delay={i * 70}>
            <div className="h-full rounded-xl border border-ink/10 bg-white p-5">
              <div className="flex items-center justify-between">
                <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-forest-50 text-forest-700 ring-1 ring-forest-100">
                  <step.icon className="h-4.5 w-4.5" aria-hidden />
                </span>
                <span className="font-mono text-[10px] font-bold tracking-[0.18em] text-earth-600">
                  {String(i + 1).padStart(2, "0")}
                </span>
              </div>
              <h3 className="mt-3 font-display text-[16px] font-semibold leading-tight text-ink">{step.title}</h3>
              <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-mute">{step.text}</p>
            </div>
          </Reveal>
        ))}
      </ol>
    </PageSection>
  );
}

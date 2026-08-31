import { Container } from "@/components/container";
import { SectionHeading } from "@/components/section-heading";
import { Reveal } from "@/components/reveal";
import { Badge } from "@/components/badge";

/**
 * Procurement (§24) — the BOQ-to-payment trail.
 * "From BOQ to delivery, without losing the trail." — strongest diagram.
 */
const FLOW = [
  { label: "BOQ", note: "the plan's quantities" },
  { label: "Material requirement", note: "what the phase needs" },
  { label: "Supplier quotes", note: "prices from the region" },
  { label: "Comparison", note: "side by side, decided" },
  { label: "Purchase order", note: "committed, numbered" },
  { label: "Delivery", note: "photo-verified at the gate" },
  { label: "Inspection", note: "counted and checked" },
  { label: "Inventory", note: "stock on record" },
  { label: "Invoice", note: "matched to the order" },
  { label: "Payment", note: "reference recorded" },
] as const;

export function Procurement() {
  return (
    <section aria-labelledby="procurement-heading" className="relative overflow-hidden border-b border-ink/10 bg-forest-900">
      <div className="absolute inset-0 bg-survey-grid-dark" aria-hidden />
      <Container className="relative py-20 lg:py-28">
        <SectionHeading
          dark
          eyebrow="Procurement"
          title={<span id="procurement-heading">From BOQ to delivery, without losing the trail.</span>}
          description="Every material has a paper life: needed → quoted → ordered → delivered → inspected → paid. MjengoOS keeps the whole chain connected — so the question 'what happened to the cement?' always has an answer."
        />

        {/* The procurement flow — snake layout, two rows on desktop */}
        <Reveal delay={150} className="mt-14">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            {FLOW.map((step, i) => (
              <div
                key={step.label}
                className="relative rounded-lg border border-forest-700 bg-forest-950/70 p-4 transition-colors hover:border-forest-500"
              >
                <span className="font-mono text-[10px] font-bold tracking-[0.18em] text-earth-400">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <p className="mt-1.5 font-display text-[15px] font-semibold leading-tight text-forest-50">
                  {step.label}
                </p>
                <p className="mt-1 text-[11.5px] leading-snug text-forest-300/75">{step.note}</p>
              </div>
            ))}
          </div>
        </Reveal>

        <Reveal delay={220} className="mt-10">
          <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-forest-800 bg-forest-950/60 px-5 py-4">
            <p className="max-w-2xl text-[14px] leading-relaxed text-forest-300/85">
              Delivery is where money quietly leaks — short deliveries, wrong grades, phantom
              invoices. A photo at the gate, a count at inspection, an invoice matched to its
              order: the leak stops being invisible.
            </p>
            <Badge tone="dark" className="border-earth-500/40 bg-earth-500/15 text-earth-300">
              <span className="font-mono text-[10px] tracking-wider">BOQ → PAYMENT · ONE LEDGER</span>
            </Badge>
          </div>
        </Reveal>
      </Container>
    </section>
  );
}

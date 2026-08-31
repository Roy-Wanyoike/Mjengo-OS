import { ArrowRight } from "lucide-react";
import { PageSection } from "@/components/page-hero";
import { SectionHeading } from "@/components/section-heading";
import { Reveal } from "@/components/reveal";
import { Button } from "@/components/button";

/**
 * /marketplace — the "for suppliers" band: reach sites at the moment
 * they need materials. CTA → /contact "List your business".
 */
const POINTS = [
  {
    title: "Demand, not ads",
    text: "Quote requests arrive with quantities, delivery location and a deadline — from projects already building.",
  },
  {
    title: "Stock listed once",
    text: "Your yard's prices and quantities live in one place; sites compare you fairly against the region.",
  },
  {
    title: "Payments with references",
    text: "Invoices matched to orders, payments recorded with M-Pesa references — reconciliation without chasing.",
  },
];

export function SuppliersBand() {
  return (
    <PageSection tone="warm" ariaLabel="For suppliers">
      <div className="grid items-center gap-10 lg:grid-cols-[1fr_0.9fr] lg:gap-16">
        <SectionHeading
          eyebrow="For suppliers"
          title="Reach sites at the moment they need materials."
          description="A site that just used its last bag of cement is a better customer than any billboard. MjengoOS routes real, structured demand from active projects to the yards that can fulfil it."
        />

        <div>
          <ul className="space-y-4">
            {POINTS.map((p, i) => (
              <Reveal as="li" key={p.title} delay={i * 80}>
                <div className="rounded-xl border border-ink/10 bg-white p-5">
                  <h3 className="font-display text-[16px] font-semibold text-ink">{p.title}</h3>
                  <p className="mt-1.5 text-[13.5px] leading-relaxed text-ink-mute">{p.text}</p>
                </div>
              </Reveal>
            ))}
          </ul>
          <Reveal delay={280} className="mt-6">
            <Button href="/contact" variant="secondary">
              List your business
              <ArrowRight className="h-4 w-4" aria-hidden />
            </Button>
          </Reveal>
        </div>
      </div>
    </PageSection>
  );
}

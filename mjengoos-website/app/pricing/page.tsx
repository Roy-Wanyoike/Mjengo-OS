import type { Metadata } from "next";
import { Check, ArrowRight, Layers, CloudOff, ScanSearch, FileDown, Database } from "lucide-react";
import { PageHero, PageSection } from "@/components/page-hero";
import { SectionHeading } from "@/components/section-heading";
import { Container } from "@/components/container";
import { Button } from "@/components/button";
import { Reveal } from "@/components/reveal";
import { MapVisual } from "@/components/map-visual";
import { PRICING_TIERS, PRICING_FAQS } from "@/data/pricing";
import type { PricingTier } from "@/types";
import { FaqAccordion } from "./components/faq-accordion";
import { cn } from "@/lib/utils";

export const metadata: Metadata = {
  title: "Pricing",
  description:
    "Simple, honest pricing for MjengoOS. Free during early access — pilot projects keep their terms. What's included in every plan, and straight answers on what happens next.",
  alternates: { canonical: "/pricing" },
};

const ALWAYS_INCLUDED = [
  {
    icon: Layers,
    title: "The full platform",
    text: "Every module and every role surface — no gates inside the record.",
  },
  {
    icon: CloudOff,
    title: "Offline capture",
    text: "Sites without networks are the design centre, not the exception.",
  },
  {
    icon: ScanSearch,
    title: "AI assistance",
    text: "Photo, voice and anomaly analysis on your own project record.",
  },
  {
    icon: FileDown,
    title: "Built-in exports",
    text: "Reports, ledger and audit trail out in open formats, any time.",
  },
  {
    icon: Database,
    title: "Data ownership",
    text: "The record belongs to the project — not to the platform.",
  },
] as const;

export default function PricingPage() {
  return (
    <>
      <PageHero
        eyebrow="Pricing"
        title="Simple, honest pricing."
        description={
          <>
            MjengoOS is in early access. Projects joining the pilot build on the full
            platform for free — and pilot projects keep their terms when published
            pricing arrives.
          </>
        }
      />

      {/* ── Tiers ─────────────────────────────────────────────────────── */}
      <PageSection tone="paper" ariaLabel="Plans and pricing">
        <div className="grid gap-6 pt-3 lg:grid-cols-3">
          {PRICING_TIERS.map((tier, index) => (
            <TierCard key={tier.name} tier={tier} index={index} />
          ))}
        </div>
        <Reveal delay={220}>
          <p className="mt-8 text-center text-[13px] leading-relaxed text-ink-mute">
            Prices in Kenyan Shillings. No lock-in: your project record exports any
            time, in full.
          </p>
        </Reveal>
      </PageSection>

      {/* ── What's included in every plan ─────────────────────────────── */}
      <PageSection tone="forest" ariaLabel="What is included in every plan">
        <SectionHeading
          dark
          eyebrow="Always included"
          title="Everything in every plan."
          description="The full platform is the product. We don't hold the modules that make the record trustworthy behind a tier."
        />
        <ul className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-5">
          {ALWAYS_INCLUDED.map((item, i) => (
            <Reveal key={item.title} as="li" delay={i * 70}>
              <div className="h-full rounded-xl border-hairline-dark bg-forest-900/60 p-5">
                <item.icon className="h-5 w-5 text-earth-400" aria-hidden />
                <h3 className="mt-3 text-[14.5px] font-semibold text-forest-50">{item.title}</h3>
                <p className="mt-1.5 text-[13px] leading-relaxed text-forest-300/85">{item.text}</p>
              </div>
            </Reveal>
          ))}
        </ul>
      </PageSection>

      {/* ── FAQ ────────────────────────────────────────────────────────── */}
      <PageSection tone="paper" id="faq" ariaLabel="Pricing questions">
        <SectionHeading
          eyebrow="FAQ"
          title="Questions about pricing."
          description="The same answers we give on the phone — no asterisks."
        />
        <Reveal className="mt-10 max-w-3xl" delay={100}>
          <FaqAccordion items={PRICING_FAQS} />
        </Reveal>
      </PageSection>

      {/* ── CTA band ───────────────────────────────────────────────────── */}
      <section
        aria-labelledby="pricing-cta-heading"
        className="relative overflow-hidden bg-forest-900"
      >
        <div className="absolute inset-0 bg-survey-grid-dark" aria-hidden />
        <div className="absolute inset-0 opacity-50" aria-hidden>
          <MapVisual dark className="h-full w-full" />
        </div>
        <Container className="relative py-16 sm:py-20">
          <Reveal className="max-w-2xl">
            <h2
              id="pricing-cta-heading"
              className="font-display text-3xl font-semibold leading-tight tracking-tight text-forest-50 sm:text-4xl"
            >
              Not sure which plan?
            </h2>
            <p className="mt-4 text-lg leading-relaxed text-forest-300/90">
              Tell us about your project and we&apos;ll tell you honestly whether
              MjengoOS fits — including when the answer is &ldquo;not yet&rdquo;.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Button href="/contact" size="lg">
                Talk to us
                <ArrowRight className="h-4 w-4" aria-hidden />
              </Button>
              <Button href="/signup" size="lg" variant="outline-dark">
                Request early access
              </Button>
            </div>
          </Reveal>
        </Container>
      </section>
    </>
  );
}

/* ── Tier card ─────────────────────────────────────────────────────────── */

function TierCard({ tier, index }: { tier: PricingTier; index: number }) {
  const highlighted = Boolean(tier.highlight);
  return (
    <Reveal delay={index * 90} className="flex pt-3">
      <article
        className={cn(
          "relative flex w-full flex-col rounded-2xl p-7",
          highlighted
            ? "border border-earth-500/60 bg-forest-900 text-forest-50 shadow-[0_2px_4px_rgb(23_25_24/0.18),0_24px_48px_-24px_rgb(18_60_50/0.85)]"
            : "border border-ink/10 bg-white",
        )}
      >
        {highlighted && (
          <span className="absolute -top-3.5 left-6 inline-flex items-center gap-1.5 rounded-full border border-earth-300/70 bg-earth-100 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-earth-700">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-earth-500" aria-hidden />
            Current stage
          </span>
        )}

        <h3 className="font-display text-lg font-semibold">{tier.name}</h3>

        <p className="mt-3 flex flex-wrap items-baseline gap-x-2">
          <span className="font-display text-4xl font-semibold tracking-tight">{tier.price}</span>
          <span className={cn("text-[13px]", highlighted ? "text-forest-300/80" : "text-ink-mute")}>
            {tier.period}
          </span>
        </p>
        <p
          className={cn(
            "mt-2 text-[14px] leading-relaxed",
            highlighted ? "text-forest-300/90" : "text-ink-mute",
          )}
        >
          {tier.tagline}
        </p>

        <ul
          className={cn(
            "mt-6 space-y-2.5 border-t pt-6",
            highlighted ? "border-forest-700" : "border-ink/10",
          )}
        >
          {tier.features.map((feature) => (
            <li key={feature} className="flex items-start gap-2.5 text-[14.5px]">
              <Check
                className={cn(
                  "mt-0.5 h-4 w-4 shrink-0",
                  highlighted ? "text-earth-400" : "text-verified",
                )}
                aria-hidden
              />
              <span className={cn(highlighted ? "text-forest-100" : "text-ink-soft")}>
                {feature}
              </span>
            </li>
          ))}
        </ul>

        <div className="mt-auto pt-7">
          <Button
            href={tier.cta.href}
            variant={highlighted ? "primary" : index === 1 ? "secondary" : "ghost"}
            className="w-full"
          >
            {tier.cta.label}
            <ArrowRight className="h-4 w-4" aria-hidden />
          </Button>
          {tier.footnote && (
            <p
              className={cn(
                "mt-3 text-center text-[12.5px] leading-relaxed",
                highlighted ? "text-forest-300/70" : "text-ink-mute",
              )}
            >
              {tier.footnote}
            </p>
          )}
        </div>
      </article>
    </Reveal>
  );
}

import { ArrowRight } from "lucide-react";
import { Container } from "@/components/container";
import { Button } from "@/components/button";
import { Reveal } from "@/components/reveal";
import { MapVisual } from "@/components/map-visual";

/**
 * /marketplace — final CTA band (compact local version of the house
 * CTA pattern).
 */
export function MarketplaceCtaBand() {
  return (
    <section aria-labelledby="marketplace-cta-heading" className="relative overflow-hidden bg-forest-900">
      <div className="absolute inset-0 bg-survey-grid-dark" aria-hidden />
      <div className="absolute inset-0 opacity-50" aria-hidden>
        <MapVisual dark className="h-full w-full" />
      </div>
      <div className="absolute inset-0 bg-gradient-to-b from-forest-900/40 via-transparent to-forest-900/70" aria-hidden />

      <Container className="relative py-16 text-center sm:py-20">
        <Reveal>
          <p className="mx-auto max-w-xl font-mono text-[11px] uppercase tracking-[0.22em] text-earth-400">
            Quote · Compare · Order · Verify · Pay
          </p>
        </Reveal>
        <Reveal delay={80}>
          <h2
            id="marketplace-cta-heading"
            className="mx-auto mt-4 max-w-2xl font-display text-3xl font-semibold leading-[1.08] tracking-tight text-forest-50 sm:text-4xl"
          >
            One trail, from the first quote to the last payment.
          </h2>
        </Reveal>
        <Reveal delay={160}>
          <p className="mx-auto mt-5 max-w-xl text-[16px] leading-relaxed text-forest-300/90">
            Start a project and the marketplace comes with it — quantities, comparisons and verified
            deliveries already connected.
          </p>
        </Reveal>
        <Reveal delay={240} className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Button href="/signup" size="lg">
            Start a Project
            <ArrowRight className="h-4 w-4" aria-hidden />
          </Button>
          <Button href="/materials" size="lg" variant="outline-dark">
            See how pricing works
          </Button>
        </Reveal>
        <Reveal delay={320}>
          <p className="mt-6 text-[13px] text-forest-300/70">
            Early access — we onboarding projects in Nairobi &amp; Kiambu first.
          </p>
        </Reveal>
      </Container>
    </section>
  );
}

import { ArrowRight } from "lucide-react";
import { Container } from "@/components/container";
import { Button } from "@/components/button";
import { Reveal } from "@/components/reveal";
import { MapVisual } from "@/components/map-visual";

/**
 * Final CTA (§35) — "Build with evidence."
 */
export function CTA() {
  return (
    <section aria-labelledby="cta-heading" className="relative overflow-hidden bg-forest-900">
      <div className="absolute inset-0 bg-survey-grid-dark" aria-hidden />
      <div className="absolute inset-0 opacity-60" aria-hidden>
        <MapVisual dark className="h-full w-full" />
      </div>
      <div className="absolute inset-0 bg-gradient-to-b from-forest-900/40 via-transparent to-forest-900/80" aria-hidden />

      <Container className="relative py-24 text-center lg:py-32">
        <Reveal>
          <p className="mx-auto max-w-2xl font-mono text-[11px] uppercase tracking-[0.22em] text-earth-400">
            Kenya first · Africa next · Global eventually
          </p>
        </Reveal>
        <Reveal delay={80}>
          <h2 id="cta-heading" className="mx-auto mt-5 max-w-3xl font-display text-4xl font-bold leading-[1.05] tracking-tight text-forest-50 sm:text-5xl lg:text-6xl">
            Build with evidence.
          </h2>
        </Reveal>
        <Reveal delay={160}>
          <p className="mx-auto mt-6 max-w-2xl text-lg leading-relaxed text-forest-300/90">
            From the land beneath your project to the money funding it and the work happening
            every day, MjengoOS gives you a clearer picture of what is really happening.
          </p>
        </Reveal>
        <Reveal delay={240} className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Button href="/signup" size="lg">
            Start a Project
            <ArrowRight className="h-4 w-4" aria-hidden />
          </Button>
          <Button href="/platform" size="lg" variant="outline-dark">
            Explore the Platform
          </Button>
        </Reveal>
        <Reveal delay={320}>
          <p className="mt-8 text-[13px] text-forest-300/70">
            Early access — we onboarding projects in Nairobi &amp; Kiambu first.
          </p>
        </Reveal>
      </Container>
    </section>
  );
}

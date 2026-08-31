import { ArrowRight } from "lucide-react";
import { Container } from "@/components/container";
import { Button } from "@/components/button";
import { Reveal } from "@/components/reveal";
import { MapVisual } from "@/components/map-visual";

/**
 * /ai — final CTA band (compact local version of the house
 * CTA pattern).
 */
export function AiCtaBand() {
  return (
    <section aria-labelledby="ai-cta-heading" className="relative overflow-hidden bg-forest-900">
      <div className="absolute inset-0 bg-survey-grid-dark" aria-hidden />
      <div className="absolute inset-0 opacity-50" aria-hidden>
        <MapVisual dark className="h-full w-full" />
      </div>
      <div className="absolute inset-0 bg-gradient-to-b from-forest-900/40 via-transparent to-forest-900/70" aria-hidden />

      <Container className="relative py-16 text-center sm:py-20">
        <Reveal>
          <p className="mx-auto max-w-xl font-mono text-[11px] uppercase tracking-[0.22em] text-earth-400">
            See · Listen · Understand · Detect — then a human decides
          </p>
        </Reveal>
        <Reveal delay={80}>
          <h2
            id="ai-cta-heading"
            className="mx-auto mt-4 max-w-2xl font-display text-3xl font-semibold leading-[1.08] tracking-tight text-forest-50 sm:text-4xl"
          >
            Intelligence that answers to the record.
          </h2>
        </Reveal>
        <Reveal delay={160}>
          <p className="mx-auto mt-5 max-w-xl text-[16px] leading-relaxed text-forest-300/90">
            See the AI layer in the platform tour — or start a project and let it read yours.
          </p>
        </Reveal>
        <Reveal delay={240} className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Button href="/platform" size="lg">
            Explore the platform
            <ArrowRight className="h-4 w-4" aria-hidden />
          </Button>
          <Button href="/signup" size="lg" variant="outline-dark">
            Start a Project
          </Button>
        </Reveal>
        <Reveal delay={320}>
          <p className="mt-6 text-[13px] text-forest-300/70">
            Advisory by design — AI never independently makes high-risk financial, legal or engineering
            decisions.
          </p>
        </Reveal>
      </Container>
    </section>
  );
}

"use client";

import { ArrowRight, ChevronDown, MapPin, Wifi, Camera } from "lucide-react";
import { Container } from "@/components/container";
import { Button } from "@/components/button";
import { DashboardMockup } from "@/components/product/dashboard-mockup";
import { MapVisual } from "@/components/map-visual";
import { Reveal } from "@/components/reveal";
import { track } from "@/lib/analytics";

export function Hero() {
  return (
    <section className="relative overflow-hidden border-b border-ink/10">
      {/* Survey-grid + contour background */}
      <div className="absolute inset-0 bg-survey-grid" aria-hidden />
      <div className="absolute inset-0 opacity-90" aria-hidden>
        <MapVisual className="h-full w-full" />
      </div>
      {/* Soft vignette to keep text contrast */}
      <div className="absolute inset-0 bg-gradient-to-b from-paper/40 via-paper/60 to-paper" aria-hidden />

      <Container className="relative pb-16 pt-14 sm:pt-20 lg:pb-24 lg:pt-24">
        <div className="grid items-center gap-12 lg:grid-cols-[1fr_1.15fr] lg:gap-16">
          {/* Copy */}
          <div className="max-w-xl">
            <Reveal>
              <p className="inline-flex items-center gap-2 rounded-full border border-forest-100 bg-forest-50/80 px-3 py-1 text-xs font-medium text-forest-800 backdrop-blur">
                <MapPin className="h-3.5 w-3.5 text-earth-600" aria-hidden />
                The operating system for real-world construction
              </p>
            </Reveal>

            <Reveal delay={80}>
              <h1 className="mt-5 font-display text-[42px] font-bold leading-[1.02] tracking-tight text-ink sm:text-6xl">
                Build with{" "}
                <span className="relative whitespace-nowrap text-forest-800">
                  evidence.
                  <svg
                    viewBox="0 0 120 8"
                    preserveAspectRatio="none"
                    aria-hidden
                    className="absolute -bottom-1.5 left-0 h-2.5 w-full text-earth-500"
                  >
                    <path d="M2 6 Q 30 1, 60 4 T 118 3" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
                  </svg>
                </span>
              </h1>
            </Reveal>

            <Reveal delay={160}>
              <p className="mt-6 text-lg leading-relaxed text-ink-mute sm:text-xl">
                From land verification to project completion, MjengoOS connects the people, materials, money
                and physical evidence behind your construction project.
              </p>
            </Reveal>

            <Reveal delay={240} className="mt-8 flex flex-col gap-3 sm:flex-row">
              <Button
                href="/signup"
                size="lg"
                onClick={() => track("hero_cta_clicked", { cta: "start_project" })}
              >
                Start a Project
                <ArrowRight className="h-4 w-4" aria-hidden />
              </Button>
              <Button href="/platform" size="lg" variant="secondary" onClick={() => track("hero_cta_clicked", { cta: "explore_platform" })}>
                Explore the Platform
              </Button>
            </Reveal>

            <Reveal delay={320}>
              <p className="mt-8 flex flex-wrap items-center gap-x-5 gap-y-2 text-[13px] text-ink-mute">
                <span className="inline-flex items-center gap-1.5">
                  <Camera className="h-3.5 w-3.5 text-forest-600" aria-hidden />
                  Photo evidence with GPS + time
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <Wifi className="h-3.5 w-3.5 text-forest-600" aria-hidden />
                  Works offline on site
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <MapPin className="h-3.5 w-3.5 text-forest-600" aria-hidden />
                  Kenya first · Africa next
                </span>
              </p>
            </Reveal>
          </div>

          {/* Product visual */}
          <Reveal delay={150} className="relative">
            <DashboardMockup />
          </Reveal>
        </div>

        {/* Scroll hint */}
        <div className="mt-14 hidden justify-center lg:flex" aria-hidden>
          <ChevronDown className="h-5 w-5 animate-bounce text-ink-faint" />
        </div>
      </Container>
    </section>
  );
}

import type { Metadata } from "next";
import { ArrowRight } from "lucide-react";
import { PageHero, PageSection } from "@/components/page-hero";
import { SectionHeading } from "@/components/section-heading";
import { Button } from "@/components/button";
import { Reveal } from "@/components/reveal";
import { MapVisual } from "@/components/map-visual";
import { ROLES } from "@/data/roles";
import { RoleCards } from "./components/role-cards";

export const metadata: Metadata = {
  title: "Solutions",
  description:
    "Built for every role on the build. Client, site supervisor, contractor, professional, supplier and finance — the same MjengoOS project record, shaped for the seat you sit in.",
  alternates: { canonical: "/solutions" },
};

/**
 * /solutions — role index. Six role cards from data/roles.ts plus a closing
 * "not sure which fits" band routed to /contact.
 */
export default function SolutionsPage() {
  return (
    <>
      <PageHero
        eyebrow="Solutions"
        title="Built for every role on the build."
        description="A project has many seats — the client funding it, the supervisor running the site, the contractor answerable for it, the professionals stamping it, the suppliers feeding it, the finance team auditing it. MjengoOS gives each one the same record, shaped for their view."
      />

      <PageSection tone="paper" ariaLabel="Solutions by role">
        <SectionHeading
          eyebrow="Choose your seat"
          title="Six surfaces. One source of truth."
          description="What changes between roles is what you see and what you can do — not which project you're looking at. Pick a role to see the problem it solves and the surface it gets."
        />
        <RoleCards roles={ROLES} />
      </PageSection>

      {/* Not sure which fits? */}
      <PageSection tone="dark" className="relative overflow-hidden" ariaLabel="Not sure which fits">
        <div className="absolute inset-0 bg-survey-grid-dark" aria-hidden />
        <div className="absolute inset-0 opacity-40" aria-hidden>
          <MapVisual dark className="h-full w-full" />
        </div>
        <div className="relative mx-auto max-w-2xl text-center">
          <Reveal>
            <h2 className="font-display text-3xl font-semibold leading-[1.08] tracking-tight text-forest-50 sm:text-4xl">
              Not sure which fits?
            </h2>
          </Reveal>
          <Reveal delay={90}>
            <p className="mx-auto mt-4 max-w-xl text-[16px] leading-relaxed text-forest-300/90">
              Tell us about your project — where it is, who is on it, and what keeps you up at
              night. We&apos;ll show you the surface that matches your seat on the build.
            </p>
          </Reveal>
          <Reveal delay={180} className="mt-8 flex justify-center">
            <Button href="/contact" size="lg">
              Tell us about your project
              <ArrowRight className="h-4 w-4" aria-hidden />
            </Button>
          </Reveal>
        </div>
      </PageSection>
    </>
  );
}

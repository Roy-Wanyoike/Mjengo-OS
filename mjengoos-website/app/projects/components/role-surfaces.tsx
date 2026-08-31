import { ArrowRight } from "lucide-react";
import { PageSection } from "@/components/page-hero";
import { SectionHeading } from "@/components/section-heading";
import { Reveal } from "@/components/reveal";
import { SiteLink } from "@/components/site-link";
import { Button } from "@/components/button";

/**
 * /projects — the role surfaces link band: every role reads the same
 * record differently. Role chips → /solutions/[slug].
 */
const ROLES = [
  { name: "Client", slug: "client" },
  { name: "Site Supervisor", slug: "site-supervisors" },
  { name: "Contractor", slug: "contractors" },
  { name: "Professional", slug: "professionals" },
  { name: "Supplier", slug: "suppliers" },
  { name: "Finance", slug: "finance" },
];

export function RoleSurfaces() {
  return (
    <PageSection tone="paper" ariaLabel="Every role, its own surface">
      <div className="flex flex-col items-start justify-between gap-8 lg:flex-row lg:items-end">
        <SectionHeading
          eyebrow="Role surfaces"
          title="One record. Six windows onto it."
          description="The client watches progress, the supervisor runs the day, the contractor answers for the build, the professional publishes reports, the supplier quotes, finance reconciles — all reading the same record through their own surface."
          className="max-w-2xl"
        />
        <Reveal delay={160} className="shrink-0">
          <Button href="/solutions" variant="secondary">
            Explore solutions by role
            <ArrowRight className="h-4 w-4" aria-hidden />
          </Button>
        </Reveal>
      </div>

      <ul className="mt-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {ROLES.map((role, i) => (
          <Reveal as="li" key={role.slug} delay={i * 60}>
            <SiteLink
              href={`/solutions/${role.slug}`}
              className="group flex items-center justify-between gap-3 rounded-xl border border-ink/10 bg-white px-5 py-4 transition-colors hover:border-forest-300 hover:bg-forest-50/40"
            >
              <span className="font-display text-[15.5px] font-semibold text-ink">{role.name}</span>
              <span className="flex items-center gap-1.5 text-[12.5px] font-medium text-ink-mute transition-colors group-hover:text-forest-800">
                View surface
                <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" aria-hidden />
              </span>
            </SiteLink>
          </Reveal>
        ))}
      </ul>
    </PageSection>
  );
}

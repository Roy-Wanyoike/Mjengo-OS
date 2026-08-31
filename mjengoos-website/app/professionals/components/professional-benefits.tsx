import { ClipboardList, FileCheck2, Camera, MapPinned } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { PageSection } from "@/components/page-hero";
import { SectionHeading } from "@/components/section-heading";
import { Reveal } from "@/components/reveal";

/**
 * /professionals — what professionals get on MjengoOS: assignments,
 * report publishing, evidence attachment, service area + ratings.
 */
const BENEFITS: { icon: LucideIcon; title: string; text: string }[] = [
  {
    icon: ClipboardList,
    title: "Assignments",
    text: "Matched to projects by trade, county and service area — clients who need exactly what you're licensed to do.",
  },
  {
    icon: FileCheck2,
    title: "Report publishing",
    text: "Survey results, verification reports and legal opinions published straight into the project record — your work, on file, attributed to you.",
  },
  {
    icon: Camera,
    title: "Evidence attachment",
    text: "Photos, plans and documents attached to your findings — a beacon sketch, a title search, an inspection walk, all in one place.",
  },
  {
    icon: MapPinned,
    title: "Service area + ratings",
    text: "Counties you serve on your profile; ratings from completed assignments — reputation built on work that stayed on record.",
  },
];

export function ProfessionalBenefits() {
  return (
    <PageSection tone="paper" ariaLabel="What professionals get">
      <div className="grid items-center gap-12 lg:grid-cols-[1fr_0.85fr] lg:gap-16">
        <div>
          <SectionHeading
            eyebrow="What you get"
            title="Work that respects the profession."
            description="No chaser fees, no invisible middlemen — the platform's job is to connect licensed professionals to projects that need them, and to keep their work attributed."
          />

          <ul className="mt-8 grid gap-4 sm:grid-cols-2">
            {BENEFITS.map((b, i) => (
              <Reveal as="li" key={b.title} delay={i * 70}>
                <div className="h-full rounded-xl border border-ink/10 bg-white p-5">
                  <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-forest-50 text-forest-700 ring-1 ring-forest-100">
                    <b.icon className="h-4.5 w-4.5" aria-hidden />
                  </span>
                  <h3 className="mt-3 font-display text-[16px] font-semibold text-ink">{b.title}</h3>
                  <p className="mt-1.5 text-[13px] leading-relaxed text-ink-mute">{b.text}</p>
                </div>
              </Reveal>
            ))}
          </ul>
        </div>

        {/* Photo side panel */}
        <Reveal delay={120}>
          <figure className="overflow-hidden rounded-xl border border-ink/10 shadow-[0_24px_64px_-28px_rgb(23_25_24/0.4)]">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/images/architect.jpg"
              alt="An architect reviewing building plans and drawings at a desk"
              className="aspect-[4/5] w-full object-cover sm:aspect-[4/3] lg:aspect-[4/5]"
              loading="lazy"
            />
            <figcaption className="border-t border-ink/10 bg-paper px-4 py-3 text-[11.5px] leading-relaxed text-ink-mute">
              Plans, reports, opinions — professional output belongs in the project record, not in a
              drawer.
            </figcaption>
          </figure>
        </Reveal>
      </div>
    </PageSection>
  );
}

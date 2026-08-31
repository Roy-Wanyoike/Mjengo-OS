import { Landmark, DraftingCompass, Cog, Calculator, HardHat, ArrowRight, BadgeCheck } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { PageSection } from "@/components/page-hero";
import { SectionHeading } from "@/components/section-heading";
import { Reveal } from "@/components/reveal";
import { SiteLink } from "@/components/site-link";

/**
 * /professionals — the professional types grid. Five cards, each with the
 * role on a MjengoOS project and its real Kenyan credential body.
 *
 * Credential bodies (real):
 *  - Surveyors licensed under the Survey Act (Cap 299) — Land Surveyors Board
 *  - Architects & Quantity Surveyors — BORAQS
 *  - Engineers — EBK
 *  - Contractors — NCA
 */
const TYPES: {
  icon: LucideIcon;
  name: string;
  role: string;
  body: string;
}[] = [
  {
    icon: Landmark,
    name: "Surveyor",
    role: "Re-establishes beacons, verifies boundaries and documents the parcel before and during the build — the first professional your project meets.",
    body: "Licensed under the Survey Act · Land Surveyors Board",
  },
  {
    icon: DraftingCompass,
    name: "Architect",
    role: "Translates the brief into designs and drawings — approved plans attach to the project record and steer every phase after them.",
    body: "BORAQS — Board of Registration of Architects & Quantity Surveyors",
  },
  {
    icon: Cog,
    name: "Engineer",
    role: "Owns structural and services design, calculations and site instructions — recorded against the phases they govern.",
    body: "EBK — Engineers Board of Kenya",
  },
  {
    icon: Calculator,
    name: "Quantity Surveyor",
    role: "Prices the BOQ, values variations and keeps cost advice attached to actual quantities — not round estimates.",
    body: "BORAQS — Board of Registration of Architects & Quantity Surveyors",
  },
  {
    icon: HardHat,
    name: "Contractor",
    role: "Executes the build, with daily evidence, attendance records and milestone sign-offs flowing into the same record.",
    body: "NCA — National Construction Authority",
  },
];

export function ProfessionalTypes() {
  return (
    <PageSection tone="paper" ariaLabel="Professional types">
      <SectionHeading
        eyebrow="The network"
        title="Five professions, one record."
        description="Every one of these roles leaves work that the project needs to keep. On MjengoOS their reports, plans and sign-offs land in the project record — tied to the phases, parcels and payments they relate to."
      />

      <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {TYPES.map((t, i) => (
          <Reveal key={t.name} delay={i * 60}>
            <article className="flex h-full flex-col rounded-xl border border-ink/10 bg-white p-6 transition-colors hover:border-forest-300">
              <div className="flex items-center gap-3.5">
                <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-forest-800 text-forest-50">
                  <t.icon className="h-5 w-5" aria-hidden />
                </span>
                <h3 className="font-display text-lg font-semibold text-ink">{t.name}</h3>
              </div>
              <p className="mt-3.5 flex-1 text-[14px] leading-relaxed text-ink-mute">{t.role}</p>
              <p className="mt-5 flex items-start gap-2 border-t border-ink/10 pt-4 font-mono text-[10.5px] uppercase leading-relaxed tracking-[0.12em] text-ink-faint">
                <BadgeCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-earth-600" aria-hidden />
                {t.body}
              </p>
            </article>
          </Reveal>
        ))}

        {/* Sixth tile — the join CTA */}
        <Reveal delay={TYPES.length * 60}>
          <SiteLink
            href="/contact"
            className="group flex h-full flex-col rounded-xl border border-dashed border-forest-300 bg-forest-50/50 p-6 transition-colors hover:border-forest-600 hover:bg-forest-50"
          >
            <h3 className="font-display text-lg font-semibold text-forest-800">
              Are you one of them?
            </h3>
            <p className="mt-3.5 flex-1 text-[14px] leading-relaxed text-forest-700/80">
              Licensed in Kenya and interested in project work that respects your profession? Join the
              network during early access.
            </p>
            <span className="mt-5 inline-flex items-center gap-1.5 border-t border-forest-100 pt-4 text-[14px] font-semibold text-forest-800">
              Join the professional network
              <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" aria-hidden />
            </span>
          </SiteLink>
        </Reveal>
      </div>

      <Reveal delay={380}>
        <p className="mt-8 max-w-3xl text-[13px] leading-relaxed text-ink-mute">
          Credential bodies referenced as record, not endorsement: MjengoOS lists the Kenyan bodies that
          license each profession so clients know whose register a licence belongs to. The bodies themselves
          have no affiliation with MjengoOS.
        </p>
      </Reveal>
    </PageSection>
  );
}

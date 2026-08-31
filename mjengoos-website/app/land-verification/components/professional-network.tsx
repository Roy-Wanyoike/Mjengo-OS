import { MapPinned, Scale, Camera } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { PageSection } from "@/components/page-hero";
import { SectionHeading } from "@/components/section-heading";
import { Reveal } from "@/components/reveal";
import { SiteLink } from "@/components/site-link";
import { DemoChip, VerificationBadge } from "@/components/badge";
import { ArrowRight } from "lucide-react";

/**
 * /land-verification — the "connect with verified professionals" band:
 * three cards (surveyor / lawyer / physical inspector) beside a real photo
 * of a surveyor at work. Badges show the product's licence-checked language.
 */
const PROFESSIONALS: {
  icon: LucideIcon;
  name: string;
  verifies: string;
}[] = [
  {
    icon: MapPinned,
    name: "Surveyor",
    verifies:
      "Re-establishes beacons, verifies boundaries against the survey plan, and documents encroachments and differences on a plan you keep.",
  },
  {
    icon: Scale,
    name: "Lawyer",
    verifies:
      "Reviews the title, the official search and any encumbrances — then records a written opinion in the passport, in plain language.",
  },
  {
    icon: Camera,
    name: "Physical inspector",
    verifies:
      "Walks the parcel, photographs boundaries and occupation, and documents what actually exists on the ground today.",
  },
];

export function ProfessionalNetwork() {
  return (
    <PageSection tone="paper" ariaLabel="Connect with verified professionals">
      <div className="grid items-center gap-12 lg:grid-cols-[0.9fr_1.1fr] lg:gap-16">
        {/* Photo side panel */}
        <Reveal>
          <figure className="relative overflow-hidden rounded-xl border border-ink/10 shadow-[0_24px_64px_-28px_rgb(23_25_24/0.4)]">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/images/surveyor.jpg"
              alt="A licensed surveyor in Kenya taking measurements with a survey instrument on a plot of land"
              className="aspect-[4/3] w-full object-cover lg:aspect-[4/5]"
              loading="lazy"
            />
            <figcaption className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-2 bg-gradient-to-t from-ink/70 to-transparent px-4 pb-3 pt-8">
              <span className="text-[11.5px] font-medium text-white">
                Beacon verification, on site — licensed surveyor with instrument
              </span>
            </figcaption>
          </figure>
          <Reveal delay={80}>
            <p className="mt-4 flex items-center gap-2 text-[12.5px] leading-relaxed text-ink-mute">
              <DemoChip />
              <span>Badge states shown are the product&rsquo;s verification language.</span>
            </p>
          </Reveal>
        </Reveal>

        {/* Cards */}
        <div>
          <SectionHeading
            eyebrow="Verified professionals"
            title="The people who do the checking."
            description="Each stage of the workflow belongs to a professional whose licence is checked before they take assignments on MjengoOS — and whose findings land directly in the passport."
          />

          <ul className="mt-8 space-y-4">
            {PROFESSIONALS.map((p, i) => (
              <Reveal as="li" key={p.name} delay={i * 80}>
                <article className="rounded-xl border border-ink/10 bg-white p-5 transition-colors hover:border-forest-300">
                  <div className="flex flex-wrap items-center justify-between gap-2.5">
                    <div className="flex items-center gap-3.5">
                      <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-forest-800 text-forest-50">
                        <p.icon className="h-5 w-5" aria-hidden />
                      </span>
                      <h3 className="font-display text-[17px] font-semibold text-ink">{p.name}</h3>
                    </div>
                    <VerificationBadge state="verified" label="Licence checked" />
                  </div>
                  <p className="mt-3 text-[14px] leading-relaxed text-ink-mute">{p.verifies}</p>
                  <p className="mt-2.5 font-mono text-[10.5px] uppercase tracking-[0.14em] text-ink-faint">
                    Licence reference recorded at verification
                  </p>
                </article>
              </Reveal>
            ))}
          </ul>

          <Reveal delay={280}>
            <p className="mt-6 text-[14px] leading-relaxed text-ink-mute">
              Curious how licence checks work — and what they honestly mean?{" "}
              <SiteLink
                href="/professionals"
                className="font-medium text-forest-800 underline decoration-earth-400/60 underline-offset-2 hover:decoration-earth-500"
              >
                See the professional network
                <ArrowRight className="ml-1 inline h-3.5 w-3.5" aria-hidden />
              </SiteLink>
            </p>
          </Reveal>
        </div>
      </div>
    </PageSection>
  );
}

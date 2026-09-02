import { SectionHeading } from "@/components/section-heading";
import { Reveal } from "@/components/reveal";
import { PageSection } from "@/components/page-hero";
import { asset } from "@/lib/utils";

/**
 * /materials — short editorial block on material price opacity in the
 * region, beside the real cement-yard photo.
 */
export function PriceEditorial() {
  return (
    <PageSection tone="paper" ariaLabel="Why price transparency matters">
      <div className="grid items-center gap-12 lg:grid-cols-[1fr_1fr] lg:gap-16">
        <div>
          <SectionHeading
            eyebrow="The problem"
            title="The same bag of cement, three prices, no explanation."
            description="Material pricing across the region runs on phone calls and relationships. The price you hear depends on who answers, what day it is, and how much they think the job can carry — not on anything you can check."
          />
          <Reveal delay={120}>
            <p className="mt-6 max-w-lg text-[15px] leading-relaxed text-ink-mute">
              For a client funding a build from far away, that opacity is expensive in the most boring way
              possible: a little on every bag, every bar, every trip of ballast — repeating quietly for
              months. Not scandal. Just fog.
            </p>
          </Reveal>
          <Reveal delay={180}>
            <p className="mt-5 max-w-lg border-l-2 border-earth-500 pl-4 text-[15px] italic leading-relaxed text-ink-soft">
              Price transparency is not a luxury feature of construction software. It is the difference
              between a budget and a guess.
            </p>
          </Reveal>
        </div>

        <Reveal delay={100} className="min-w-0">
          <figure className="overflow-hidden rounded-xl border border-ink/10 shadow-[0_24px_64px_-28px_rgb(23_25_24/0.4)]">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={asset("/images/materials.jpg")}
              alt="Stacked bags of cement in a Kenyan building materials yard"
              className="aspect-[4/3] w-full object-cover"
              loading="lazy"
            />
            <figcaption className="border-t border-ink/10 bg-paper px-4 py-3 text-[11.5px] leading-relaxed text-ink-mute">
              The most traded item on any Kenyan site — and the one whose price varies the most between
              yards.
            </figcaption>
          </figure>
        </Reveal>
      </div>
    </PageSection>
  );
}

import { X } from "lucide-react";
import { PageSection } from "@/components/page-hero";
import { SectionHeading } from "@/components/section-heading";
import { Reveal } from "@/components/reveal";

/**
 * /land-verification — the honesty block. What MjengoOS does NOT do:
 * no government integration claims, no title guarantees. The registry
 * remains authoritative (§18).
 */
const NOT_ITEMS: { title: string; text: string }[] = [
  {
    title: "We do not verify titles.",
    text: "The lands registry is the authority on ownership. MjengoOS organizes its outputs — it does not replace them.",
  },
  {
    title: "We do not claim government integration.",
    text: "Official searches are obtained by people and attached to the record. There is no live registry link, and we will not pretend otherwise.",
  },
  {
    title: "We do not guarantee a clean plot.",
    text: "A passport shows what the record says — including its problems. Resolving them belongs to professionals and the registry.",
  },
  {
    title: "We do not replace your lawyer.",
    text: "Their opinion becomes part of the record; it never originates from the platform. Legal advice stays licensed, human and accountable.",
  },
];

export function HonestyBlock() {
  return (
    <PageSection tone="dark" ariaLabel="What MjengoOS does not do">
      <SectionHeading
        dark
        eyebrow="Honesty, in writing"
        title="What MjengoOS does not do."
        description="A verification workflow you can trust starts with what it cannot promise. Four things, stated plainly:"
      />

      <ul className="mt-10 grid gap-4 sm:grid-cols-2">
        {NOT_ITEMS.map((item, i) => (
          <Reveal as="li" key={item.title} delay={i * 70}>
            <article className="h-full rounded-xl border border-forest-800 bg-forest-950/60 p-5">
              <div className="flex items-start gap-3.5">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-alert-soft text-alert">
                  <X className="h-4 w-4" aria-hidden />
                </span>
                <div>
                  <h3 className="font-display text-[16.5px] font-semibold text-forest-50">{item.title}</h3>
                  <p className="mt-1.5 text-[13.5px] leading-relaxed text-forest-300/85">{item.text}</p>
                </div>
              </div>
            </article>
          </Reveal>
        ))}
      </ul>

      <Reveal delay={300}>
        <p className="mt-8 max-w-2xl text-[15px] leading-relaxed text-forest-300/85">
          The registry remains authoritative. MjengoOS keeps the work of the registry, the surveyors and the
          lawyers organized, attached to the parcel, and impossible to lose — that is the whole claim, and it
          is enough.
        </p>
      </Reveal>
    </PageSection>
  );
}

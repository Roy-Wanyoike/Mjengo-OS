import { Container } from "@/components/container";
import { SectionHeading } from "@/components/section-heading";
import { Reveal } from "@/components/reveal";
import { MapVisual } from "@/components/map-visual";

/**
 * The MjengoOS ecosystem (§3): the full chain from land to completion.
 * Rendered as an infrastructure pipeline — the site's defining diagram.
 */
const CHAIN = [
  { label: "Land", note: "verification" },
  { label: "Professionals", note: "licensed & verified" },
  { label: "Planning", note: "BOQ & phases" },
  { label: "Construction", note: "daily record" },
  { label: "Workers", note: "attendance & pay" },
  { label: "Materials", note: "prices & stock" },
  { label: "Procurement", note: "quotes to delivery" },
  { label: "Money", note: "wallet & approvals" },
  { label: "Progress", note: "photo-verified" },
  { label: "Evidence", note: "GPS + timestamps" },
  { label: "Completion", note: "the full record" },
] as const;

export function Ecosystem() {
  return (
    <section aria-labelledby="ecosystem-heading" className="relative overflow-hidden border-b border-ink/10 bg-forest-900">
      <div className="absolute inset-0 bg-survey-grid-dark" aria-hidden />
      <div className="absolute inset-0 opacity-50" aria-hidden>
        <MapVisual dark className="h-full w-full" />
      </div>

      <Container className="relative py-20 lg:py-28">
        <SectionHeading
          dark
          eyebrow="The ecosystem"
          title={<span id="ecosystem-heading">One connected record, from the ground up.</span>}
          description="Construction isn't one tool — it's a chain. MjengoOS connects every link, so the record builds itself as the work happens."
        />

        <Reveal delay={150} className="mt-14">
          <ol
            aria-label="The MjengoOS chain: land, professionals, planning, construction, workers, materials, procurement, money, progress, evidence, completion"
            className="flex flex-wrap items-stretch justify-center gap-2.5"
          >
            {CHAIN.map((link, i) => {
              const isLast = i === CHAIN.length - 1;
              return (
                <li key={link.label} className="flex items-center gap-2.5">
                  <div
                    className={
                      isLast
                        ? "flex min-w-[120px] flex-col items-center rounded-lg border border-earth-400/40 bg-earth-500/15 px-4 py-3 text-center"
                        : "flex min-w-[110px] flex-col items-center rounded-lg border border-forest-700 bg-forest-950/60 px-4 py-3 text-center"
                    }
                  >
                    <span className={isLast ? "font-display text-[15px] font-semibold text-earth-300" : "font-display text-[15px] font-semibold text-forest-50"}>
                      {link.label}
                    </span>
                    <span className="mt-0.5 text-[10.5px] text-forest-300/70">{link.note}</span>
                  </div>
                  {!isLast && (
                    <span aria-hidden className="text-forest-600">
                      <svg viewBox="0 0 12 12" className="h-3 w-3">
                        <path d="M1 6h8M6 2.5 9.5 6 6 9.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </span>
                  )}
                </li>
              );
            })}
          </ol>
        </Reveal>

        <Reveal delay={250}>
          <p className="mx-auto mt-10 max-w-2xl text-center font-mono text-xs tracking-[0.14em] text-forest-300/60">
            LAND + PEOPLE + MATERIALS + MONEY + PHYSICAL EVIDENCE + AI = MJENGOOS
          </p>
          <p className="mx-auto mt-4 max-w-xl text-center text-[13.5px] leading-relaxed text-forest-300/80">
            Not a marketplace. Not a spreadsheet. Not an AI wrapper. The infrastructure layer
            connecting the physical construction world.
          </p>
        </Reveal>
      </Container>
    </section>
  );
}

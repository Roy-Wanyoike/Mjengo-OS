import { PageSection } from "@/components/page-hero";
import { SectionHeading } from "@/components/section-heading";
import { Reveal } from "@/components/reveal";
import { MapVisual } from "@/components/map-visual";

/**
 * /platform — "how the modules connect" band. The chain concept from the
 * homepage ecosystem section, compressed to the money path: the work that
 * gets planned, bought, built, proven and paid for — all on one record.
 */
const CHAIN = [
  { label: "Planning", note: "BOQ & milestones" },
  { label: "Procurement", note: "quotes → delivery" },
  { label: "Construction", note: "the daily record" },
  { label: "Evidence", note: "GPS + timestamp" },
  { label: "Payment", note: "approved release" },
] as const;

export function ModuleChain() {
  return (
    <PageSection tone="dark" className="relative overflow-hidden" ariaLabel="How the modules connect">
      <div className="absolute inset-0 bg-survey-grid-dark" aria-hidden />
      <div className="absolute inset-0 opacity-50" aria-hidden>
        <MapVisual dark className="h-full w-full" />
      </div>

      <div className="relative">
        <SectionHeading
          dark
          eyebrow="How the modules connect"
          title="One record, from the plan to the payment."
          description="Each handoff writes to the same record. The plan prices the materials, the materials become deliveries, the deliveries become the day's evidence, and the evidence releases the money. Nothing is re-keyed between steps."
        />

        <Reveal delay={150} className="mt-12">
          <ol
            aria-label="The module chain: planning, procurement, construction, evidence, payment"
            className="flex flex-wrap items-stretch justify-center gap-2.5"
          >
            {CHAIN.map((link, i) => {
              const isLast = i === CHAIN.length - 1;
              return (
                <li key={link.label} className="flex items-center gap-2.5">
                  <div
                    className={
                      isLast
                        ? "flex min-w-[150px] flex-col items-center rounded-lg border border-earth-400/40 bg-earth-500/15 px-5 py-3.5 text-center"
                        : "flex min-w-[150px] flex-col items-center rounded-lg border border-forest-700 bg-forest-950/60 px-5 py-3.5 text-center"
                    }
                  >
                    <span
                      className={
                        isLast
                          ? "font-display text-[16px] font-semibold text-earth-300"
                          : "font-display text-[16px] font-semibold text-forest-50"
                      }
                    >
                      {link.label}
                    </span>
                    <span className="mt-0.5 text-[11px] text-forest-300/70">{link.note}</span>
                  </div>
                  {!isLast && (
                    <span aria-hidden className="text-forest-600">
                      <svg viewBox="0 0 12 12" className="h-3.5 w-3.5">
                        <path
                          d="M1 6h8M6 2.5 9.5 6 6 9.5"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.6"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </span>
                  )}
                </li>
              );
            })}
          </ol>
        </Reveal>

        <Reveal delay={250}>
          <p className="mx-auto mt-10 max-w-2xl text-center font-mono text-[11px] uppercase tracking-[0.18em] text-forest-300/60">
            Plan · Buy · Build · Prove · Pay — one record
          </p>
          <p className="mx-auto mt-4 max-w-xl text-center text-[13.5px] leading-relaxed text-forest-300/80">
            Break any link and the build still happens — but the record stops, the arguments
            start, and someone pays for the gap. MjengoOS keeps the chain intact.
          </p>
        </Reveal>
      </div>
    </PageSection>
  );
}

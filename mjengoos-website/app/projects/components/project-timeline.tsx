import { Check } from "lucide-react";
import { PageSection } from "@/components/page-hero";
import { SectionHeading } from "@/components/section-heading";
import { Reveal } from "@/components/reveal";
import { DemoChip } from "@/components/badge";
import { cn } from "@/lib/utils";

/**
 * /projects — the full project timeline (local version of the homepage
 * timeline pattern): 10 stages with ✓/●/○ states — completed with
 * evidence, current, ahead (§31). Demo-labelled.
 */
const STAGES = [
  { label: "Land", state: "done" },
  { label: "Design", state: "done" },
  { label: "BOQ", state: "done" },
  { label: "Contractor", state: "done" },
  { label: "Procurement", state: "done" },
  { label: "Foundation", state: "done" },
  { label: "Structure", state: "current" },
  { label: "Roofing", state: "ahead" },
  { label: "Finishing", state: "ahead" },
  { label: "Handover", state: "ahead" },
] as const;

type State = (typeof STAGES)[number]["state"];

function Marker({ state }: { state: State }) {
  if (state === "done") {
    return (
      <span className="relative z-10 flex h-8 w-8 items-center justify-center rounded-full bg-verified text-white shadow-[0_0_0_4px_var(--color-forest-950)]">
        <Check className="h-4 w-4" aria-hidden />
      </span>
    );
  }
  if (state === "current") {
    return (
      <span className="relative z-10 flex h-8 w-8 items-center justify-center rounded-full bg-earth-500 text-ink shadow-[0_0_0_4px_var(--color-forest-950)]">
        <span className="h-2.5 w-2.5 rounded-full bg-ink/70" aria-hidden />
      </span>
    );
  }
  return (
    <span className="relative z-10 flex h-8 w-8 items-center justify-center rounded-full border-2 border-forest-700 bg-forest-950 text-forest-300/50 shadow-[0_0_0_4px_var(--color-forest-950)]">
      <span className="h-2.5 w-2.5 rounded-full border-2 border-forest-600 bg-transparent" aria-hidden />
    </span>
  );
}

export function ProjectTimeline() {
  const currentIndex = STAGES.findIndex((s) => s.state === "current");

  return (
    <PageSection tone="forest" className="relative overflow-hidden" ariaLabel="The full project timeline">
      <div className="absolute inset-0 bg-survey-grid-dark" aria-hidden />
      <div className="relative">
        <div className="flex flex-wrap items-end justify-between gap-6">
          <SectionHeading
            dark
            eyebrow="Project timeline"
            title="The whole build, on one line."
            description="Example project — every stage anchored to the evidence and decisions that closed it. Nothing turns green because someone said so."
          />
          <DemoChip className="border-forest-700 bg-forest-950/60 text-forest-300" />
        </div>

        <Reveal delay={150} className="mt-14">
          <ol
            aria-label="Project timeline: land, design, BOQ, contractor, procurement and foundation complete; structure in progress; roofing, finishing and handover ahead"
            className="relative grid gap-0 sm:grid-cols-5 lg:grid-cols-10"
          >
            {/* Connector rail — behind the markers (desktop) */}
            <span
              aria-hidden
              className="absolute left-[5%] right-[5%] top-4 hidden h-0.5 bg-forest-800 sm:block"
            />
            {/* Progress rail — completed stages into the current one */}
            <span
              aria-hidden
              className="absolute top-4 hidden h-0.5 bg-verified/70 sm:block"
              style={{ left: "5%", width: `${currentIndex * 10}%` }}
            />
            {STAGES.map((stage) => (
              <li
                key={stage.label}
                className="relative z-10 flex flex-row items-center gap-3 py-3 sm:flex-col sm:items-start sm:gap-4 sm:py-0"
              >
                <Marker state={stage.state} />
                <div className="sm:min-h-[44px]">
                  <p
                    className={cn(
                      "font-display text-[14.5px] font-semibold",
                      stage.state === "current"
                        ? "text-earth-300"
                        : stage.state === "done"
                          ? "text-forest-50"
                          : "text-forest-300/60",
                    )}
                  >
                    {stage.label}
                  </p>
                  <p className="text-[10.5px] uppercase tracking-[0.14em] text-forest-300/50">
                    {stage.state === "done" ? "complete" : stage.state === "current" ? "in progress" : "ahead"}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        </Reveal>

        <Reveal delay={220}>
          <div className="mt-12 flex flex-wrap items-center gap-x-8 gap-y-3 text-[12.5px] text-forest-300/70">
            <span className="flex items-center gap-2">
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-verified text-white">
                <Check className="h-3 w-3" aria-hidden />
              </span>
              Completed with evidence
            </span>
            <span className="flex items-center gap-2">
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-earth-500">
                <span className="h-1.5 w-1.5 rounded-full bg-ink/70" aria-hidden />
              </span>
              Current phase
            </span>
            <span className="flex items-center gap-2">
              <span className="flex h-5 w-5 items-center justify-center rounded-full border-2 border-forest-700 bg-transparent" />
              Ahead
            </span>
          </div>
        </Reveal>
      </div>
    </PageSection>
  );
}

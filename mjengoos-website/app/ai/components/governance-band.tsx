import { UserRound, Cpu, FileCheck2, UserRoundCheck, CircleCheck, ChevronRight, Check, X } from "lucide-react";
import { PageSection } from "@/components/page-hero";
import { SectionHeading } from "@/components/section-heading";
import { Reveal } from "@/components/reveal";

/**
 * /ai — the governance band (dark): Human input → AI processing →
 * Structured insight → Human review → Action. Explicit: AI never
 * independently makes high-risk financial, legal or engineering
 * decisions; output is advisory and reviewable (§29).
 */
const FLOW = [
  { icon: UserRound, label: "Human input" },
  { icon: Cpu, label: "AI processing" },
  { icon: FileCheck2, label: "Structured insight" },
  { icon: UserRoundCheck, label: "Human review" },
  { icon: CircleCheck, label: "Action" },
] as const;

const DOES = [
  "Drafts records from voice notes and photos",
  "Extracts structure from plans and documents",
  "Flags cost, material and schedule patterns",
  "Carries every output with a confidence state",
];

const DOES_NOT = [
  "Approve payments or release milestones",
  "Sign off engineering or legal decisions",
  "Replace surveyors, engineers or lawyers",
  "Act without a named human reviewing it",
];

export function GovernanceBand() {
  return (
    <PageSection tone="forest" ariaLabel="AI governance">
      <SectionHeading
        dark
        eyebrow="Governance"
        title="Every AI path passes through a person."
        description="AI never independently makes high-risk financial, legal or engineering decisions. Its output is advisory and reviewable — a draft until a human confirms it, a flag until a human resolves it."
      />

      <Reveal delay={140} className="mt-12">
        <ol
          className="flex flex-wrap items-center justify-center gap-2 sm:gap-2.5"
          aria-label="AI governance workflow: human input, AI processing, structured insight, human review, action"
        >
          {FLOW.map((step, i) => {
            const isReview = step.label === "Human review";
            return (
              <li key={step.label} className="flex items-center gap-2 sm:gap-2.5">
                <span
                  className={
                    isReview
                      ? "flex items-center gap-2.5 rounded-lg border border-caution/50 bg-caution-soft px-4 py-2.5"
                      : "flex items-center gap-2.5 rounded-lg border border-forest-700 bg-forest-950/70 px-4 py-2.5 transition-colors hover:border-forest-500"
                  }
                >
                  <step.icon
                    className={`h-4.5 w-4.5 shrink-0 ${isReview ? "text-caution" : "text-earth-300"}`}
                    aria-hidden
                  />
                  <span
                    className={`font-display text-[13.5px] font-semibold ${
                      isReview ? "text-caution" : "text-forest-50"
                    }`}
                  >
                    {step.label}
                  </span>
                  <span className="font-mono text-[9.5px] font-bold tracking-[0.16em] text-forest-300/60">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                </span>
                {i < FLOW.length - 1 && (
                  <ChevronRight className="h-3.5 w-3.5 shrink-0 text-forest-600" aria-hidden />
                )}
              </li>
            );
          })}
        </ol>
      </Reveal>

      <div className="mt-10 grid gap-5 lg:grid-cols-2">
        <Reveal delay={200}>
          <div className="h-full rounded-xl border border-forest-800 bg-forest-950/70 p-6">
            <h3 className="font-display text-[16.5px] font-semibold text-forest-50">What the AI layer does</h3>
            <ul className="mt-4 space-y-3">
              {DOES.map((item) => (
                <li key={item} className="flex items-start gap-3">
                  <Check className="mt-0.5 h-4.5 w-4.5 shrink-0 text-forest-300" aria-hidden />
                  <span className="text-[14px] leading-relaxed text-forest-300/90">{item}</span>
                </li>
              ))}
            </ul>
          </div>
        </Reveal>
        <Reveal delay={260}>
          <div className="h-full rounded-xl border border-caution/30 bg-forest-950/70 p-6">
            <h3 className="font-display text-[16.5px] font-semibold text-earth-300">What it never does</h3>
            <ul className="mt-4 space-y-3">
              {DOES_NOT.map((item) => (
                <li key={item} className="flex items-start gap-3">
                  <X className="mt-0.5 h-4.5 w-4.5 shrink-0 text-caution" aria-hidden />
                  <span className="text-[14px] leading-relaxed text-forest-300/90">{item}</span>
                </li>
              ))}
            </ul>
          </div>
        </Reveal>
      </div>
    </PageSection>
  );
}

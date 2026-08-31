import { Eye, Ear, BrainCircuit, Radar, Mic, ArrowRight, AlertTriangle } from "lucide-react";
import { Container } from "@/components/container";
import { SectionHeading } from "@/components/section-heading";
import { Reveal } from "@/components/reveal";
import { Button } from "@/components/button";
import { Badge, DemoChip } from "@/components/badge";

/**
 * AI section (§26-29) — SEE / LISTEN / UNDERSTAND / DETECT,
 * photo example, voice example, anomaly detection.
 * Governance made explicit: human review, no autonomous high-risk decisions.
 */
const CAPABILITIES = [
  {
    icon: Eye,
    name: "See",
    text: "Photo-based progress analysis — walls, slabs, roofing stages read from site photos.",
  },
  {
    icon: Ear,
    name: "Listen",
    text: "Voice notes transformed into structured records — Swahili and Sheng included.",
  },
  {
    icon: BrainCircuit,
    name: "Understand",
    text: "Project and document intelligence — extract structure from plans and records.",
  },
  {
    icon: Radar,
    name: "Detect",
    text: "Cost, material and schedule anomalies — flagged early, for human review.",
  },
] as const;

const WORKFLOW = ["Human input", "AI processing", "Structured insight", "Human review", "Action"] as const;

export function AI() {
  return (
    <section aria-labelledby="ai-heading" className="border-b border-ink/10 bg-paper-warm/60">
      <Container className="py-20 lg:py-28">
        <SectionHeading
          eyebrow="AI, grounded"
          title={<span id="ai-heading">AI that works with your project data.</span>}
          description="The intelligence layer runs on what your site actually produced — photos, voice notes, deliveries, budgets. AI amplifies the record; it never replaces the people accountable for it."
        />

        {/* Four capabilities */}
        <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {CAPABILITIES.map((cap, i) => (
            <Reveal key={cap.name} delay={i * 70}>
              <article className="h-full rounded-xl border border-ink/10 bg-white p-6 shadow-[0_1px_2px_rgb(23_25_24/0.04)]">
                <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-forest-800 text-forest-50">
                  <cap.icon className="h-5 w-5" aria-hidden />
                </span>
                <h3 className="mt-4 font-display text-lg font-semibold uppercase tracking-wide text-ink">
                  {cap.name}
                </h3>
                <p className="mt-2 text-[14px] leading-relaxed text-ink-mute">{cap.text}</p>
              </article>
            </Reveal>
          ))}
        </div>

        {/* Governance workflow */}
        <Reveal delay={150} className="mt-10">
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-ink/10 bg-white px-5 py-4">
            <span className="mr-1 text-[10.5px] font-semibold uppercase tracking-[0.16em] text-ink-mute">
              Every AI path
            </span>
            {WORKFLOW.map((step, i) => (
              <span key={step} className="flex items-center gap-2">
                <span
                  className={
                    step === "Human review"
                      ? "rounded-md border border-caution/40 bg-caution-soft px-3 py-1.5 text-[12.5px] font-semibold text-caution"
                      : "rounded-md border border-ink/10 bg-paper px-3 py-1.5 text-[12.5px] font-medium text-ink-soft"
                  }
                >
                  {step}
                </span>
                {i < WORKFLOW.length - 1 && (
                  <ArrowRight className="h-3 w-3 text-ink-faint" aria-hidden />
                )}
              </span>
            ))}
            <span className="ml-auto hidden text-[12px] text-ink-mute lg:block">
              AI does not independently make high-risk financial, legal or engineering decisions.
            </span>
          </div>
        </Reveal>

        <div className="mt-12 grid gap-8 lg:grid-cols-2">
          {/* Photo example (§27) */}
          <Reveal>
            <div className="h-full overflow-hidden rounded-xl border border-ink/10 bg-white shadow-[0_24px_64px_-28px_rgb(23_25_24/0.3)]">
              <div className="flex items-center justify-between border-b border-ink/10 px-5 py-3.5">
                <p className="font-display text-[15px] font-semibold text-ink">Photo progress analysis</p>
                <DemoChip />
              </div>
              <div className="grid gap-px bg-ink/10 sm:grid-cols-2">
                <div className="bg-white p-4">
                  <p className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-ink-mute">Before · Day 18</p>
                  <div className="mt-2 overflow-hidden rounded-lg">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src="/images/foundation.jpg" alt="Foundation phase of a building under construction with formwork" className="aspect-[4/3] w-full object-cover" loading="lazy" />
                  </div>
                  <p className="mt-2 text-[12.5px] font-medium text-ink">Foundation</p>
                </div>
                <div className="bg-white p-4">
                  <p className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-ink-mute">Current · Day 47</p>
                  <div className="relative mt-2 overflow-hidden rounded-lg">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src="/images/ground-truth.jpg" alt="Ground floor walls substantially complete with formwork for ring beam" className="aspect-[4/3] w-full object-cover" loading="lazy" />
                    <span className="absolute right-2 top-2 rounded-md bg-earth-500 px-2 py-0.5 text-[10.5px] font-bold text-ink">82%</span>
                  </div>
                  <p className="mt-2 text-[12.5px] font-medium text-ink">Ground floor walls</p>
                </div>
              </div>
              <div className="border-t border-ink/10 bg-forest-50/60 px-5 py-4">
                <p className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-forest-800">
                  <Eye className="h-4 w-4" aria-hidden /> AI observation
                </p>
                <p className="mt-1.5 text-[13.5px] leading-relaxed text-ink-soft">
                  Walls appear substantially complete. Formwork visible for ring beam — next phase
                  likely ready to schedule.
                </p>
                <div className="mt-3 flex flex-wrap items-center gap-2.5">
                  <Badge tone="caution">Confidence: Medium</Badge>
                  <span className="text-[12px] text-ink-mute">Human review recommended</span>
                </div>
              </div>
            </div>
          </Reveal>

          {/* Voice example (§28) + anomaly (§29) */}
          <div className="flex flex-col gap-8">
            <Reveal delay={80}>
              <div className="overflow-hidden rounded-xl border border-ink/10 bg-white shadow-[0_24px_64px_-28px_rgb(23_25_24/0.3)]">
                <div className="flex items-center justify-between border-b border-ink/10 px-5 py-3.5">
                  <p className="font-display text-[15px] font-semibold text-ink">Voice note → structured record</p>
                  <DemoChip />
                </div>
                <div className="px-5 py-4">
                  <div className="flex items-center gap-3 rounded-lg bg-forest-900 px-4 py-3">
                    <Mic className="h-5 w-5 shrink-0 text-earth-400" aria-hidden />
                    <div className="flex h-8 items-end gap-[3px]" aria-hidden>
                      {[6, 12, 8, 16, 10, 20, 14, 9, 18, 12, 7, 15, 11, 6, 13, 8].map((h, i) => (
                        <span key={i} className="w-[3px] rounded-full bg-earth-400/80" style={{ height: `${h * 2}px` }} />
                      ))}
                    </div>
                    <span className="ml-auto font-mono text-[10.5px] text-forest-300">0:08</span>
                  </div>
                  <p className="mt-3 text-[14px] italic leading-relaxed text-ink-soft">
                    "Nimepokea 20 bags za cement na 5 rolls za wire kutoka Karioke Hardware…"
                  </p>
                  <ArrowRight className="mt-3 h-4 w-4 text-ink-faint" aria-hidden />
                  <dl className="mt-3 grid gap-2 text-[13.5px] sm:grid-cols-2">
                    {[
                      ["Materials", "20 × cement · 5 × binding wire"],
                      ["Supplier", "Karioke Hardware"],
                      ["Project", "Karen Residence"],
                      ["Status", "Draft — review required"],
                    ].map(([k, v]) => (
                      <div key={k} className="rounded-lg border border-ink/10 bg-paper px-3.5 py-2.5">
                        <dt className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-mute">{k}</dt>
                        <dd className="mt-0.5 font-medium text-ink">{v}</dd>
                      </div>
                    ))}
                  </dl>
                  <p className="mt-3 text-[11.5px] leading-relaxed text-ink-mute">
                    The site team speaks; MjengoOS drafts the record. A human confirms before it
                    becomes project data.
                  </p>
                </div>
              </div>
            </Reveal>

            {/* Anomaly detection (§29) */}
            <Reveal delay={140}>
              <div className="overflow-hidden rounded-xl border border-caution/30 bg-white shadow-[0_24px_64px_-28px_rgb(23_25_24/0.3)]">
                <div className="flex items-center justify-between border-b border-caution/20 bg-caution-soft px-5 py-3.5">
                  <p className="flex items-center gap-2 font-display text-[15px] font-semibold text-ink">
                    <AlertTriangle className="h-4.5 w-4.5 text-caution" aria-hidden />
                    Project alert
                  </p>
                  <DemoChip />
                </div>
                <div className="grid gap-px bg-ink/10 sm:grid-cols-3">
                  <div className="bg-white p-4">
                    <p className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-ink-mute">Cement consumption</p>
                    <p className="mt-1 font-display text-2xl font-semibold tabular-nums text-caution">+24%</p>
                    <p className="text-[11.5px] text-ink-mute">vs the phase's plan</p>
                  </div>
                  <div className="bg-white p-4">
                    <p className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-ink-mute">Construction progress</p>
                    <p className="mt-1 font-display text-2xl font-semibold tabular-nums text-ink">+8%</p>
                    <p className="text-[11.5px] text-ink-mute">in the same period</p>
                  </div>
                  <div className="flex items-center bg-white p-4">
                    <Badge tone="caution" className="text-[11px]">Review recommended</Badge>
                  </div>
                </div>
                <p className="border-t border-ink/10 bg-paper px-5 py-3 text-[11.5px] leading-relaxed text-ink-mute">
                  Anomalies are patterns to review — not accusations. MjengoOS says what differs,
                  humans decide why. Wastage, rework, theft and data errors all look like this at
                  first; only a review can tell them apart.
                </p>
              </div>
            </Reveal>
          </div>
        </div>

        <Reveal delay={160} className="mt-10 flex flex-wrap gap-3">
          <Button href="/ai" variant="secondary">
            Explore the AI layer
            <ArrowRight className="h-4 w-4" aria-hidden />
          </Button>
        </Reveal>
      </Container>
    </section>
  );
}

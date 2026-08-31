import { Camera, MapPin, Clock, FolderOpen, Sparkles, UserCheck, Database, ArrowRight } from "lucide-react";
import { Container } from "@/components/container";
import { SectionHeading } from "@/components/section-heading";
import { Reveal } from "@/components/reveal";
import { DemoChip } from "@/components/badge";
import { Button } from "@/components/button";

/**
 * Physical Ground Truth (§16) — the core differentiator.
 * The evidence chain: SITE → PHOTO → GPS → TIMESTAMP → PROJECT → AI → HUMAN REVIEW → RECORD.
 */
const CHAIN = [
  { icon: Camera, label: "Photo", note: "captured on site" },
  { icon: MapPin, label: "GPS", note: "where it happened" },
  { icon: Clock, label: "Timestamp", note: "when it happened" },
  { icon: FolderOpen, label: "Project", note: "filed to the record" },
  { icon: Sparkles, label: "AI analysis", note: "what it shows" },
  { icon: UserCheck, label: "Human review", note: "confirmed by people" },
  { icon: Database, label: "Project record", note: "permanent evidence" },
] as const;

export function GroundTruth() {
  return (
    <section aria-labelledby="ground-truth-heading" className="border-b border-ink/10 bg-paper">
      <Container className="py-20 lg:py-28">
        <SectionHeading
          eyebrow="Physical ground truth"
          title={
            <span id="ground-truth-heading">
              AI can analyze the site.
              <br />
              Someone still has to be there.
            </span>
          }
          description="AI has never poured concrete or watched a delivery truck arrive. People capture what is happening — MjengoOS turns that physical evidence into structured project intelligence."
        />

        <div className="mt-14 grid items-center gap-10 lg:grid-cols-[1fr_1.1fr] lg:gap-16">
          {/* Photo evidence chain */}
          <Reveal>
            <div className="relative">
              {/* Real site photo with evidence overlay */}
              <figure className="relative overflow-hidden rounded-xl border border-ink/10 shadow-[0_24px_64px_-28px_rgb(23_25_24/0.4)]">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src="/images/ground-truth.jpg"
                  alt="Construction site in Kenya — workers on a walling phase with formwork and scaffolding"
                  className="aspect-[4/3] w-full object-cover"
                  loading="lazy"
                />
                {/* Evidence overlay chips — the product's capture metadata */}
                <div className="absolute left-3 top-3 flex flex-wrap gap-2">
                  <span className="flex items-center gap-1.5 rounded-md bg-ink/75 px-2.5 py-1 font-mono text-[10.5px] text-white backdrop-blur-sm">
                    <MapPin className="h-3 w-3 text-earth-400" aria-hidden /> -1.3190, 36.7765
                  </span>
                  <span className="flex items-center gap-1.5 rounded-md bg-ink/75 px-2.5 py-1 font-mono text-[10.5px] text-white backdrop-blur-sm">
                    <Clock className="h-3 w-3 text-earth-400" aria-hidden /> Day 47 · 14:32 EAT
                  </span>
                </div>
                <div className="absolute bottom-3 left-3 right-3 flex items-center justify-between">
                  <span className="rounded-md bg-forest-900/85 px-2.5 py-1 text-[11px] font-medium text-forest-50 backdrop-blur-sm">
                    Karen Residence · Walling — East elevation
                  </span>
                  <span className="hidden rounded-md bg-earth-500/95 px-2.5 py-1 text-[11px] font-semibold text-ink backdrop-blur-sm sm:inline-flex">
                    82% wall complete
                  </span>
                </div>
              </figure>

              {/* Floating review card */}
              <div className="absolute -bottom-6 -right-3 w-[240px] rounded-xl border border-ink/10 bg-white p-4 shadow-xl sm:-right-6 sm:w-[270px]">
                <div className="flex items-center justify-between">
                  <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-mute">
                    <Sparkles className="h-3.5 w-3.5 text-earth-600" aria-hidden /> AI observation
                  </p>
                  <DemoChip />
                </div>
                <p className="mt-2 text-[13px] font-medium leading-snug text-ink">
                  Walls appear substantially complete; formwork for ring beam visible.
                </p>
                <p className="mt-2 flex items-center justify-between text-[11px] text-ink-mute">
                  <span>Confidence: Medium</span>
                  <span className="font-semibold text-caution">Human review recommended</span>
                </p>
              </div>
            </div>
          </Reveal>

          {/* The chain */}
          <div>
            <Reveal>
              <ol className="relative space-y-1" aria-label="The evidence chain from photo to project record">
                {/* The chain starts at the site */}
                <li className="flex items-center gap-3 rounded-lg bg-forest-800 px-4 py-3">
                  <span className="font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-earth-300">Site</span>
                  <span className="text-[13.5px] font-medium text-forest-50">Someone is physically there</span>
                </li>
                {CHAIN.map((step, i) => (
                  <li key={step.label} className="relative">
                    <span aria-hidden className="absolute -top-2 left-6 flex h-4 w-4 items-center justify-center text-ink-faint">
                      <svg viewBox="0 0 12 12" className="h-3 w-3 rotate-90">
                        <path d="M1 6h8M6 2.5 9.5 6 6 9.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </span>
                    <Reveal delay={i * 60}>
                      <div className="flex items-center gap-3.5 rounded-lg border border-ink/10 bg-white px-4 py-3 transition-colors hover:border-forest-300">
                        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-forest-50 text-forest-700 ring-1 ring-forest-100">
                          <step.icon className="h-4 w-4" aria-hidden />
                        </span>
                        <span className="font-display text-[15px] font-semibold text-ink">{step.label}</span>
                        <span className="ml-auto text-[12px] text-ink-mute">{step.note}</span>
                      </div>
                    </Reveal>
                  </li>
                ))}
              </ol>
            </Reveal>

            <Reveal delay={200}>
              <p className="mt-6 max-w-md text-[15px] leading-relaxed text-ink-mute">
                MjengoOS combines human field activity with AI so project decisions are grounded in
                what is actually happening on the ground — not in what someone says is happening.
              </p>
              <Button href="/platform" variant="ghost" size="sm" className="mt-4 -ml-1">
                See how evidence flows through a project
                <ArrowRight className="h-4 w-4" aria-hidden />
              </Button>
            </Reveal>
          </div>
        </div>
      </Container>
    </section>
  );
}

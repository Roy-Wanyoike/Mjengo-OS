import { ShieldCheck, FileCheck2, Landmark, Clock } from "lucide-react";
import { PageSection } from "@/components/page-hero";
import { SectionHeading } from "@/components/section-heading";
import { Reveal } from "@/components/reveal";
import { DemoChip, Badge } from "@/components/badge";

/**
 * /platform deep dive 2 — money & approvals. A client's milestone approval
 * queue: the release waiting for them, the evidence behind it, and the items
 * not yet ready. Demo-labelled (§49); action pills are illustrative only.
 */
const BULLETS = [
  {
    icon: FileCheck2,
    title: "Evidence attached to the money",
    text: "A release request arrives with its photos, GPS stamps and supervisor sign-off already attached — approve what you can see.",
  },
  {
    icon: ShieldCheck,
    title: "Escrow-style release",
    text: "Funds stay committed to the milestone until the client approves. Nobody spends ahead of the proof.",
  },
  {
    icon: Landmark,
    title: "The ledger remembers",
    text: "Actor, timestamp, note — every approval is written to an append-only audit trail, not to someone's memory.",
  },
] as const;

export function ApprovalsDeepDive() {
  return (
    <PageSection tone="warm" ariaLabel="Deep dive: money and approvals">
      <div className="grid items-center gap-12 lg:grid-cols-[1.08fr_1fr] lg:gap-16">
        {/* Mockup: the approval queue */}
        <Reveal>
          <div className="overflow-hidden rounded-xl border border-ink/10 bg-white shadow-[0_24px_64px_-28px_rgb(23_25_24/0.35)]">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-ink/10 bg-forest-900 px-5 py-4">
              <div>
                <p className="text-[10.5px] font-semibold uppercase tracking-[0.18em] text-earth-400">
                  Approval queue
                </p>
                <p className="mt-0.5 font-display text-lg font-semibold text-forest-50">
                  Karen Residence · Client view
                </p>
              </div>
              <DemoChip className="border-forest-700 bg-forest-950/60 text-forest-300" />
            </div>

            {/* Request ready for decision */}
            <div className="border-b border-ink/10 p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-ink-mute">
                    Milestone release request
                  </p>
                  <p className="mt-1 font-display text-[18px] font-semibold text-ink">
                    Walling to ring beam
                  </p>
                </div>
                <p className="font-display text-[22px] font-semibold tabular-nums text-ink">
                  KES 650,000
                </p>
              </div>

              {/* Evidence attached chips */}
              <div className="mt-4 flex flex-wrap gap-2">
                <Badge tone="verified">
                  <FileCheck2 className="h-3 w-3" aria-hidden />
                  12 photos · GPS verified
                </Badge>
                <Badge tone="verified">Day 46 progress on record</Badge>
                <Badge tone="verified">Supervisor sign-off</Badge>
                <Badge tone="caution">1 variation priced · KES 40,000</Badge>
              </div>

              {/* Illustrative action pills — not interactive (demo) */}
              <div className="mt-5 flex flex-wrap items-center gap-3" aria-hidden>
                <span className="inline-flex h-10 items-center gap-2 rounded-md bg-earth-500 px-4 text-[14px] font-semibold text-ink">
                  Approve release
                </span>
                <span className="inline-flex h-10 items-center rounded-md border border-ink/15 px-4 text-[14px] font-medium text-ink-soft">
                  Request changes
                </span>
                <span className="ml-auto hidden items-center gap-1.5 text-[11.5px] text-ink-mute sm:flex">
                  <Clock className="h-3.5 w-3.5" aria-hidden /> requested 09:14 today
                </span>
              </div>
            </div>

            {/* Queue item waiting on evidence */}
            <div className="flex flex-wrap items-center justify-between gap-3 bg-paper px-5 py-4">
              <div className="min-w-0">
                <p className="truncate text-[14px] font-medium text-ink-mute">Roofing package · KES 1,180,000</p>
                <p className="mt-0.5 text-[12px] text-ink-mute">
                  waiting for evidence — request cannot be raised yet
                </p>
              </div>
              <Badge tone="caution">Evidence pending</Badge>
            </div>

            <p className="border-t border-ink/10 bg-paper px-5 py-3 text-[11.5px] leading-relaxed text-ink-mute">
              Money moves after the evidence, not before it. MjengoOS records the method,
              reference and timestamp of every payment made — it is not a bank and holds no deposits.
            </p>
          </div>
        </Reveal>

        {/* Copy */}
        <div>
          <SectionHeading
            eyebrow="Deep dive — Money & approvals"
            title="Money moves after the evidence, not before it."
            description="A client in Nairobi or the diaspora sees exactly what each release is for — the milestone, the amount, the proof — and the record keeps the decision: who approved, when, and with what note."
          />
          <ul className="mt-8 space-y-4">
            {BULLETS.map((b, i) => (
              <Reveal as="li" key={b.title} delay={i * 70} className="flex items-start gap-3.5">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-forest-50 text-forest-700 ring-1 ring-forest-100">
                  <b.icon className="h-4.5 w-4.5" aria-hidden />
                </span>
                <div>
                  <p className="text-[15px] font-semibold text-ink">{b.title}</p>
                  <p className="mt-0.5 text-[14px] leading-relaxed text-ink-mute">{b.text}</p>
                </div>
              </Reveal>
            ))}
          </ul>
        </div>
      </div>
    </PageSection>
  );
}

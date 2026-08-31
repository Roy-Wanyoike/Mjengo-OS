import { CheckCircle2, AlertTriangle, Clock } from "lucide-react";
import { PageSection } from "@/components/page-hero";
import { SectionHeading } from "@/components/section-heading";
import { Reveal } from "@/components/reveal";
import { DemoChip, VerificationBadge } from "@/components/badge";
import { Counter } from "@/components/counter";

/**
 * /wallet — the architecture: one wallet per project. Richer than the
 * homepage's version — available/committed/spent plus a milestone
 * release queue with Approve states and M-Pesa reference recording (§25).
 */
const BALANCE = [
  { label: "Available", value: 1840000, tone: "text-forest-700", bar: "bg-forest-600", pct: 44 },
  { label: "Committed", value: 1200000, tone: "text-caution", bar: "bg-caution", pct: 29 },
  { label: "Spent", value: 1160000, tone: "text-earth-600", bar: "bg-earth-500", pct: 27 },
] as const;

const RELEASE_QUEUE = [
  {
    name: "Walling to ring beam",
    amount: "650,000",
    icon: CheckCircle2,
    state: "verified" as const,
    label: "Approved · released",
    note: "M-Pesa ref SB7K4M2QX9 · 14 May · actor: A. Yusuf (Client)",
  },
  {
    name: "Windows & doors",
    amount: "420,000",
    icon: Clock,
    state: "pending" as const,
    label: "Awaiting client approval",
    note: "Evidence attached — client approval next",
    approve: true,
  },
  {
    name: "Roofing package",
    amount: "850,000",
    icon: AlertTriangle,
    state: "caution" as const,
    label: "Awaiting evidence",
    note: "Evidence photos pending before request opens",
  },
];

export function WalletArchitecture() {
  return (
    <PageSection tone="paper" ariaLabel="The wallet architecture">
      <div className="grid items-center gap-12 lg:grid-cols-[1fr_1.08fr] lg:gap-16">
        {/* Copy */}
        <div>
          <SectionHeading
            eyebrow="Wallet architecture"
            title="One wallet per project. Three numbers that reconcile."
            description="Available, committed, spent — the whole financial state of a build in three figures that always add up to the same budget. Money doesn't move on promises: milestones queue for release, evidence first, client approval second."
          />
          <ul className="mt-8 space-y-4">
            {[
              "Milestones enter a release queue — evidence attached, then the client's approval, then payment.",
              "Every payment records its M-Pesa reference and the actor who made it.",
              "Committed is not spent — funds earmarked for an approved milestone stay visible until they move.",
            ].map((point, i) => (
              <Reveal as="li" key={point} delay={i * 70} className="flex items-start gap-3">
                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-earth-500" aria-hidden />
                <span className="text-[15px] leading-relaxed text-ink-soft">{point}</span>
              </Reveal>
            ))}
          </ul>
        </div>

        {/* Wallet mockup */}
        <Reveal delay={100} className="min-w-0">
          <div className="overflow-hidden rounded-xl border border-ink/10 bg-white shadow-[0_24px_64px_-28px_rgb(23_25_24/0.35)]">
            <div className="flex items-center justify-between border-b border-ink/10 bg-forest-900 px-5 py-4">
              <div>
                <p className="text-[10.5px] font-semibold uppercase tracking-[0.18em] text-earth-400">Project wallet</p>
                <p className="mt-0.5 font-display text-xl font-semibold tabular-nums text-forest-50">
                  <Counter to={4200000} formatted="KES 4,200,000" />
                  <span className="ml-2 font-sans text-[12px] font-normal text-forest-300/80">· Karen Residence</span>
                </p>
              </div>
              <DemoChip className="border-forest-700 bg-forest-950/60 text-forest-300" />
            </div>

            {/* Balance cells */}
            <div className="grid gap-px bg-ink/10 sm:grid-cols-3">
              {BALANCE.map((row) => (
                <div key={row.label} className="bg-white p-5">
                  <p className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-ink-mute">{row.label}</p>
                  <p className={`mt-1.5 font-display text-xl font-semibold tabular-nums ${row.tone}`}>
                    KES {row.value.toLocaleString("en-KE")}
                  </p>
                  <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-ink/10">
                    <div className={`h-full rounded-full ${row.bar}`} style={{ width: `${row.pct}%` }} />
                  </div>
                </div>
              ))}
            </div>

            {/* Milestone release queue */}
            <div className="border-t border-ink/10">
              <p className="px-5 pt-4 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-ink-mute">
                Milestone release queue
              </p>
              <ul className="divide-y divide-ink/10 px-5 pb-2 pt-1">
                {RELEASE_QUEUE.map((row) => (
                  <li key={row.name} className="flex flex-wrap items-center gap-3 py-3">
                    <row.icon
                      className={`h-4.5 w-4.5 shrink-0 ${
                        row.state === "verified" ? "text-verified" : row.state === "caution" ? "text-caution" : "text-ink-faint"
                      }`}
                      aria-hidden
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13.5px] font-medium text-ink">{row.name}</p>
                      <p className="text-[11px] text-ink-mute">{row.note}</p>
                    </div>
                    <span className="shrink-0 font-semibold tabular-nums text-ink">KES {row.amount}</span>
                    <VerificationBadge state={row.state} label={row.label} className="shrink-0" />
                    {row.approve && (
                      <span
                        aria-hidden
                        className="shrink-0 rounded-md bg-earth-500 px-3 py-1.5 text-[11.5px] font-semibold text-ink"
                      >
                        Approve
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>

            {/* Honesty footer */}
            <p className="border-t border-ink/10 bg-paper px-5 py-3 text-[11.5px] leading-relaxed text-ink-mute">
              MjengoOS is not a bank and holds no deposits. Payments are made by people — the wallet
              records them: method, reference, timestamp, actor.
            </p>
          </div>
        </Reveal>
      </div>
    </PageSection>
  );
}

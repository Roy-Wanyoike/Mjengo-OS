import { Lock, FileDown } from "lucide-react";
import { PageSection } from "@/components/page-hero";
import { SectionHeading } from "@/components/section-heading";
import { Reveal } from "@/components/reveal";
import { DemoChip } from "@/components/badge";

/**
 * /wallet — reconciliation, not guesswork: the append-only ledger.
 * Actor + timestamp + note on every entry; audit trail export.
 */
const ENTRIES: {
  date: string;
  time: string;
  actor: string;
  entry: string;
  note: string;
  amount: string;
  positive: boolean;
}[] = [
  {
    date: "14 May",
    time: "10:04",
    actor: "A. Yusuf · Client",
    entry: "Milestone release — Walling to ring beam",
    note: "M-Pesa ref SB7K4M2QX9 · evidence attached",
    amount: "650,000",
    positive: false,
  },
  {
    date: "12 May",
    time: "16:41",
    actor: "S. Mwangi · Site",
    entry: "Cement order — Supplier B",
    note: "delivery photo verified · invoice #4471",
    amount: "93,600",
    positive: false,
  },
  {
    date: "08 May",
    time: "09:15",
    actor: "A. Yusuf · Client",
    entry: "Wallet top-up",
    note: "M-Pesa ref QK93M2XW1",
    amount: "500,000",
    positive: true,
  },
  {
    date: "02 May",
    time: "17:22",
    actor: "J. Otieno · Contractor",
    entry: "Payroll — 27 workers",
    note: "attendance-verified · M-Pesa refs recorded",
    amount: "28,300",
    positive: false,
  },
  {
    date: "28 Apr",
    time: "11:30",
    actor: "A. Yusuf · Client",
    entry: "Correction — duplicate entry 24 Apr removed",
    note: "append-only: correction, not deletion",
    amount: "12,000",
    positive: true,
  },
];

export function LedgerBlock() {
  return (
    <PageSection tone="paper" ariaLabel="Reconciliation, not guesswork">
      <div className="grid items-center gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] lg:gap-16">
        {/* Copy */}
        <div className="min-w-0">
          <SectionHeading
            eyebrow="Reconciliation, not guesswork"
            title="A ledger that cannot quietly change its mind."
            description="Entries are append-only: nothing is silently edited or deleted. A mistake becomes a correction entry with its own actor and timestamp — the history of the record is part of the record."
          />
          <ul className="mt-8 space-y-4">
            {[
              "Actor on every entry — who did it, with their role.",
              "Timestamp on every entry — when it happened, to the minute.",
              "Note on every entry — the reference, invoice or evidence behind it.",
            ].map((point, i) => (
              <Reveal as="li" key={point} delay={i * 70} className="flex items-start gap-3">
                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-earth-500" aria-hidden />
                <span className="text-[15px] leading-relaxed text-ink-soft">{point}</span>
              </Reveal>
            ))}
          </ul>
          <Reveal delay={240}>
            <div className="mt-7 flex items-start gap-3 rounded-lg border border-ink/10 bg-white px-4 py-3.5">
              <FileDown className="mt-0.5 h-5 w-5 shrink-0 text-forest-600" aria-hidden />
              <p className="text-[13.5px] leading-relaxed text-ink-mute">
                The whole audit trail exports any time, in open formats — for your accountant, your
                lender, or a court that asks.
              </p>
            </div>
          </Reveal>
        </div>

        {/* Ledger mockup */}
        <Reveal delay={100} className="min-w-0">
          <div className="overflow-hidden rounded-xl border border-ink/10 bg-white shadow-[0_24px_64px_-28px_rgb(23_25_24/0.35)]">
            <div className="flex items-center justify-between border-b border-ink/10 bg-forest-900 px-5 py-4">
              <div>
                <p className="flex items-center gap-2 text-[10.5px] font-semibold uppercase tracking-[0.18em] text-earth-400">
                  <Lock className="h-3.5 w-3.5" aria-hidden /> Append-only ledger
                </p>
                <p className="mt-0.5 font-display text-lg font-semibold text-forest-50">
                  Karen Residence · 1,214 entries
                </p>
              </div>
              <DemoChip className="border-forest-700 bg-forest-950/60 text-forest-300" />
            </div>
            <div className="overflow-x-auto scroll-thin">
              <table className="w-full min-w-[560px] text-left text-[13px]">
                <thead>
                  <tr className="border-b border-ink/10 bg-paper text-[10.5px] uppercase tracking-[0.14em] text-ink-mute">
                    <th scope="col" className="px-5 py-2.5 font-semibold">When</th>
                    <th scope="col" className="px-3 py-2.5 font-semibold">Actor</th>
                    <th scope="col" className="px-3 py-2.5 font-semibold">Entry</th>
                    <th scope="col" className="px-5 py-2.5 font-semibold text-right">Amount</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink/10">
                  {ENTRIES.map((e) => (
                    <tr key={`${e.date}-${e.entry}`} className="transition-colors hover:bg-paper/60">
                      <td className="whitespace-nowrap px-5 py-3 font-mono text-[11.5px] tabular-nums text-ink-mute">
                        {e.date} · {e.time}
                      </td>
                      <td className="whitespace-nowrap px-3 py-3 text-[12.5px] font-medium text-ink-soft">{e.actor}</td>
                      <td className="px-3 py-3">
                        <p className="font-medium text-ink">{e.entry}</p>
                        <p className="text-[11px] text-ink-mute">{e.note}</p>
                      </td>
                      <td
                        className={`whitespace-nowrap px-5 py-3 text-right font-semibold tabular-nums ${
                          e.positive ? "text-verified" : "text-ink"
                        }`}
                      >
                        {e.positive ? "+" : "−"} KES {e.amount}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="border-t border-ink/10 bg-paper px-5 py-3 text-[11.5px] text-ink-mute">
              Illustrative entries — every real entry carries actor, timestamp and note, and nothing is
              ever removed.
            </p>
          </div>
        </Reveal>
      </div>
    </PageSection>
  );
}

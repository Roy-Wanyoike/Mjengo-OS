import { ArrowRight } from "lucide-react";
import { Container } from "@/components/container";
import { SectionHeading } from "@/components/section-heading";
import { Reveal } from "@/components/reveal";
import { Button } from "@/components/button";
import { DemoChip } from "@/components/badge";
import { Counter } from "@/components/counter";

/**
 * Universal wallet (§25) — "Every project deserves a financial trail."
 * Honest: no bank claims, no regulatory capability claims.
 */
export function Wallet() {
  return (
    <section aria-labelledby="wallet-heading" className="border-b border-ink/10 bg-paper">
      <Container className="py-20 lg:py-28">
        <div className="grid items-center gap-12 lg:grid-cols-[1fr_1.05fr] lg:gap-16">
          <div>
            <SectionHeading
              eyebrow="Universal wallet"
              title={<span id="wallet-heading">Every project deserves a financial trail.</span>}
              description="Connect budgets, expenses, approvals, payments and reconciliation in one financial record — every shilling tied to the evidence that justifies it."
            />

            <Reveal delay={120}>
              <p className="mt-6 max-w-lg text-[15px] leading-relaxed text-ink-mute">
                The wallet architecture is designed to become reusable financial infrastructure
                for other applications — a project-scoped ledger of commitments, approvals and
                payments that any serious build can stand on.
              </p>
            </Reveal>

            <Reveal delay={180}>
              <p className="mt-5 rounded-lg border border-ink/10 bg-white px-4 py-3 text-[12.5px] leading-relaxed text-ink-mute">
                MjengoOS is not a bank and holds no deposits. Payments are recorded — method,
                reference, timestamp — by the people who make them.
              </p>
            </Reveal>

            <Reveal delay={220} className="mt-7 flex flex-wrap gap-3">
              <Button href="/wallet" variant="secondary">
                Explore the Wallet
                <ArrowRight className="h-4 w-4" aria-hidden />
              </Button>
            </Reveal>
          </div>

          {/* Wallet preview (demo) */}
          <Reveal delay={100} className="min-w-0">
            <div className="overflow-hidden rounded-xl border border-ink/10 bg-white shadow-[0_24px_64px_-28px_rgb(23_25_24/0.35)]">
              <div className="flex items-center justify-between border-b border-ink/10 bg-forest-900 px-5 py-4">
                <div>
                  <p className="text-[10.5px] font-semibold uppercase tracking-[0.18em] text-earth-400">Project wallet</p>
                  <p className="mt-0.5 font-display text-xl font-semibold tabular-nums text-forest-50">
                    <Counter to={4200000} formatted="KES 4,200,000" />
                  </p>
                </div>
                <DemoChip className="border-forest-700 bg-forest-950/60 text-forest-300" />
              </div>

              <div className="grid gap-px bg-ink/10 sm:grid-cols-3">
                {[
                  { label: "Available", value: 1840000, tone: "text-forest-700", bar: "bg-forest-600", pct: 44 },
                  { label: "Committed", value: 1200000, tone: "text-caution", bar: "bg-caution", pct: 29 },
                  { label: "Spent", value: 1160000, tone: "text-earth-600", bar: "bg-earth-500", pct: 27 },
                ].map((row) => (
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

              {/* Ledger preview */}
              <div className="border-t border-ink/10">
                <p className="px-5 pt-4 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-ink-mute">
                  Recent ledger entries
                </p>
                <ul className="divide-y divide-ink/10 px-5 pb-2 pt-1 text-[13px]">
                  {[
                    { text: "Milestone released — Walling to ring beam", amount: "-650,000", tag: "evidence attached" },
                    { text: "Escrow top-up — client M-Pesa", amount: "+1,200,000", tag: "ref SB7K4M2QX9" },
                    { text: "Cement order — Supplier B", amount: "-93,600", tag: "delivery photo verified" },
                  ].map((row) => (
                    <li key={row.text} className="flex items-center justify-between gap-3 py-2.5">
                      <div className="min-w-0">
                        <p className="truncate font-medium text-ink">{row.text}</p>
                        <p className="text-[11px] text-ink-mute">{row.tag}</p>
                      </div>
                      <span className={`shrink-0 font-semibold tabular-nums ${row.amount.startsWith("+") ? "text-verified" : "text-ink"}`}>
                        KES {row.amount}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </Reveal>
        </div>
      </Container>
    </section>
  );
}

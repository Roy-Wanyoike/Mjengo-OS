import { Users, UserCheck, Clock, UserX } from "lucide-react";
import { Container } from "@/components/container";
import { SectionHeading } from "@/components/section-heading";
import { Reveal } from "@/components/reveal";
import { Badge, DemoChip, VerificationBadge } from "@/components/badge";

/**
 * Workers section (§21) — "Everyone on site doesn't need a smartphone."
 * Supervisor's muster view + worker table. Simple and powerful.
 */
const WORKERS = [
  { name: "Joseph Mwangi", trade: "Mason", rate: 1200, attendance: "46/48 days", payment: "M-Pesa · paid" },
  { name: "Peter Otieno", trade: "Steel fixer", rate: 1400, attendance: "44/48 days", payment: "M-Pesa · paid" },
  { name: "Daniel Kimani", trade: "Mason", rate: 1200, attendance: "47/48 days", payment: "pending today" },
  { name: "Samuel Kariuki", trade: "Labourer", rate: 800, attendance: "45/48 days", payment: "M-Pesa · paid" },
] as const;

export function Workers() {
  return (
    <section aria-labelledby="workers-heading" className="border-b border-ink/10 bg-paper">
      <Container className="py-20 lg:py-28">
        <div className="grid items-center gap-12 lg:grid-cols-[1fr_1.1fr] lg:gap-16">
          <div>
            <SectionHeading
              eyebrow="Workers & fundis"
              title={<span id="workers-heading">Everyone on site doesn't need a smartphone.</span>}
              description="MjengoOS is designed for real construction environments. The supervisor's device is the capture point — workers clock in with a PIN, and attendance, wages and payments stay honest without anyone owning a smartphone."
            />

            <Reveal delay={120} className="mt-8">
              <div className="flex flex-wrap items-center gap-6">
                <div className="flex items-center gap-3">
                  <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-forest-800 text-forest-50">
                    <Users className="h-5 w-5" aria-hidden />
                  </span>
                  <div>
                    <p className="font-display text-2xl font-semibold tabular-nums text-ink">27</p>
                    <p className="text-[12px] text-ink-mute">workers on muster</p>
                  </div>
                </div>
                <div className="flex items-center gap-2.5">
                  <Badge tone="verified">
                    <UserCheck className="h-3.5 w-3.5" aria-hidden /> 24 present
                  </Badge>
                  <Badge tone="caution">
                    <Clock className="h-3.5 w-3.5" aria-hidden /> 2 late
                  </Badge>
                  <Badge tone="alert">
                    <UserX className="h-3.5 w-3.5" aria-hidden /> 1 absent
                  </Badge>
                </div>
              </div>
            </Reveal>

            <Reveal delay={180}>
              <p className="mt-7 max-w-md text-[15px] leading-relaxed text-ink-mute">
                Wage calculations run off verified attendance — and payments record their M-Pesa
                reference, so "paid" is a fact, not a feeling.
              </p>
            </Reveal>
          </div>

          {/* Worker table (demo) */}
          <Reveal delay={100} className="min-w-0">
            <div className="overflow-hidden rounded-xl border border-ink/10 bg-white shadow-[0_24px_64px_-28px_rgb(23_25_24/0.35)]">
              <div className="flex items-center justify-between border-b border-ink/10 px-5 py-4">
                <p className="font-display text-[15px] font-semibold text-ink">Today's muster — Karen Residence</p>
                <DemoChip />
              </div>
              <div className="overflow-x-auto scroll-thin">
                <table className="w-full min-w-[520px] text-left text-[13.5px]">
                  <thead>
                    <tr className="border-b border-ink/10 bg-paper text-[10.5px] uppercase tracking-[0.14em] text-ink-mute">
                      <th scope="col" className="px-5 py-2.5 font-semibold">Worker</th>
                      <th scope="col" className="px-3 py-2.5 font-semibold">Trade</th>
                      <th scope="col" className="px-3 py-2.5 font-semibold text-right">Daily rate</th>
                      <th scope="col" className="px-3 py-2.5 font-semibold">Attendance</th>
                      <th scope="col" className="px-5 py-2.5 font-semibold">Payment</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ink/10">
                    {WORKERS.map((w) => (
                      <tr key={w.name} className="transition-colors hover:bg-paper/60">
                        <td className="px-5 py-3 font-medium text-ink">{w.name}</td>
                        <td className="px-3 py-3 text-ink-mute">{w.trade}</td>
                        <td className="px-3 py-3 text-right tabular-nums text-ink">
                          KES {w.rate.toLocaleString("en-KE")}
                        </td>
                        <td className="px-3 py-3 tabular-nums text-ink-mute">{w.attendance}</td>
                        <td className="px-5 py-3">
                          <VerificationBadge
                            state={w.payment.includes("pending") ? "pending" : "verified"}
                            label={w.payment}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="border-t border-ink/10 bg-paper px-5 py-3 text-[11.5px] text-ink-mute">
                PIN check-in · supervisor's device · works offline and syncs when the network returns.
              </p>
            </div>
          </Reveal>
        </div>
      </Container>
    </section>
  );
}

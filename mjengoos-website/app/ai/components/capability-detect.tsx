import { Radar, AlertTriangle } from "lucide-react";
import { Reveal } from "@/components/reveal";
import { DemoChip, Badge } from "@/components/badge";

/**
 * /ai — DETECT: cost, material and schedule anomalies. Cement +24% vs
 * progress +8%, review recommended — non-accusatory by design (§29).
 */
export function CapabilityDetect() {
  return (
    <Reveal delay={200} className="h-full">
      <article className="flex h-full min-w-0 flex-col overflow-hidden rounded-xl border border-caution/30 bg-white shadow-[0_24px_64px_-28px_rgb(23_25_24/0.3)]">
        <div className="flex items-center gap-3.5 border-b border-caution/20 bg-caution-soft px-5 py-4">
          <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-forest-800 text-forest-50">
            <Radar className="h-5 w-5" aria-hidden />
          </span>
          <div>
            <h3 className="font-display text-[17px] font-semibold uppercase tracking-wide text-ink">Detect</h3>
            <p className="text-[12px] text-ink-mute">Cost, material & schedule anomalies</p>
          </div>
          <DemoChip className="ml-auto" />
        </div>

        <div className="flex flex-1 flex-col">
          <div className="grid flex-1 gap-px bg-ink/10 sm:grid-cols-3">
            <div className="bg-white p-4">
              <p className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-ink-mute">
                Cement consumption
              </p>
              <p className="mt-1 font-display text-2xl font-semibold tabular-nums text-caution">+24%</p>
              <p className="text-[11.5px] text-ink-mute">vs the phase&rsquo;s plan</p>
            </div>
            <div className="bg-white p-4">
              <p className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-ink-mute">
                Construction progress
              </p>
              <p className="mt-1 font-display text-2xl font-semibold tabular-nums text-ink">+8%</p>
              <p className="text-[11.5px] text-ink-mute">in the same period</p>
            </div>
            <div className="flex items-center bg-white p-4">
              <Badge tone="caution" className="text-[11px]">Review recommended</Badge>
            </div>
          </div>

          <p className="border-t border-ink/10 bg-paper px-5 py-3.5 text-[11.5px] leading-relaxed text-ink-mute">
            <AlertTriangle className="mr-1.5 -mt-0.5 inline h-3.5 w-3.5 text-caution" aria-hidden />
            Anomalies are patterns to review — not accusations. MjengoOS says what differs; humans decide
            why. Wastage, rework, theft and data errors all look like this at first; only a review can
            tell them apart.
          </p>
        </div>
      </article>
    </Reveal>
  );
}

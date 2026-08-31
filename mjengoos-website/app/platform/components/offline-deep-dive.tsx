import { WifiOff, Wifi, Cloud, Upload, Database, CheckCircle2 } from "lucide-react";
import { PageSection } from "@/components/page-hero";
import { SectionHeading } from "@/components/section-heading";
import { Reveal } from "@/components/reveal";
import { DemoChip } from "@/components/badge";

/**
 * /platform deep dive 3 — offline-first. Compact sync diagram following the
 * homepage offline section: field device → outbox → sync → cloud. Demo-labelled.
 */
const FLOW = [
  { icon: WifiOff, label: "No internet", note: "on site" },
  { icon: Database, label: "Local outbox", note: "stored on device" },
  { icon: Wifi, label: "4G returns", note: "any connection" },
  { icon: Upload, label: "Sync", note: "queued items upload" },
  { icon: Cloud, label: "Cloud record", note: "project updated" },
] as const;

const BULLETS = [
  "Attendance, photos, deliveries and the daily report capture with zero network.",
  "The outbox is visible — the site team can see exactly what is waiting to sync.",
  "Financial data never serves from cache; only the app's own captured outbox syncs.",
] as const;

export function OfflineDeepDive() {
  return (
    <PageSection tone="paper" ariaLabel="Deep dive: offline-first">
      <div className="grid items-center gap-12 lg:grid-cols-[1fr_1.05fr] lg:gap-16">
        {/* Copy */}
        <div>
          <SectionHeading
            eyebrow="Deep dive — Offline-first"
            title="The site has no bars. The record still gets made."
            description="Construction sites sit exactly where connectivity is worst. MjengoOS keeps capturing through the dead zones — and when the network returns, on the drive home or at the site office, the record catches up by itself."
          />
          <ul className="mt-8 space-y-3.5">
            {BULLETS.map((point, i) => (
              <Reveal as="li" key={point} delay={i * 70} className="flex items-start gap-3">
                <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-verified" aria-hidden />
                <span className="text-[15px] leading-relaxed text-ink-soft">{point}</span>
              </Reveal>
            ))}
          </ul>
        </div>

        {/* Compact sync diagram */}
        <Reveal delay={100} className="min-w-0">
          <div className="rounded-xl border border-ink/10 bg-white p-5 shadow-[0_24px_64px_-28px_rgb(23_25_24/0.3)] sm:p-6">
            <div className="flex items-center justify-between">
              <p className="text-[10.5px] font-semibold uppercase tracking-[0.16em] text-ink-mute">
                Field sync
              </p>
              <DemoChip />
            </div>

            {/* Field device */}
            <div className="mt-4 rounded-lg border-2 border-dashed border-ink/20 bg-paper p-4">
              <div className="flex items-center justify-between">
                <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-ink-mute">
                  Field device
                </p>
                <span className="flex items-center gap-1.5 rounded-full bg-alert-soft px-2.5 py-1 text-[10.5px] font-semibold text-alert">
                  <WifiOff className="h-3 w-3" aria-hidden /> No signal
                </span>
              </div>
              <div className="mt-3 grid grid-cols-3 gap-2.5 text-center">
                {[
                  { n: "27", l: "mustered" },
                  { n: "5", l: "photos" },
                  { n: "1", l: "delivery" },
                ].map((cell) => (
                  <div key={cell.l} className="rounded-lg bg-forest-900 px-2 py-3">
                    <p className="font-display text-xl font-semibold tabular-nums text-forest-50">{cell.n}</p>
                    <p className="text-[10.5px] text-forest-300/80">{cell.l} today</p>
                  </div>
                ))}
              </div>
              <p className="mt-3 text-center text-[11.5px] text-ink-mute">
                captured locally · nothing lost
              </p>
            </div>

            {/* Sync flow */}
            <ol className="mt-5 flex items-start justify-between gap-1" aria-label="Offline sync flow">
              {FLOW.map((s) => (
                <li key={s.label} className="flex flex-1 flex-col items-center text-center">
                  <span className="flex h-9 w-9 items-center justify-center rounded-full bg-forest-50 text-forest-700 ring-1 ring-forest-100">
                    <s.icon className="h-4 w-4" aria-hidden />
                  </span>
                  <p className="mt-1.5 text-[11px] font-semibold text-ink">{s.label}</p>
                  <p className="mt-0.5 hidden text-[9.5px] leading-tight text-ink-mute sm:block">{s.note}</p>
                </li>
              ))}
            </ol>

            <div className="mt-5 rounded-lg bg-verified-soft px-4 py-3 text-center">
              <p className="flex items-center justify-center gap-2 text-[13px] font-semibold text-verified">
                <Wifi className="h-4 w-4" aria-hidden />
                4G returns at 17:42 — 33 records sync, ledger updated
              </p>
            </div>
          </div>
        </Reveal>
      </div>
    </PageSection>
  );
}

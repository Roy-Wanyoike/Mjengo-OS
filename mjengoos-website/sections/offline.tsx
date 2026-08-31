import { WifiOff, Wifi, Cloud, Upload, Database } from "lucide-react";
import { Container } from "@/components/container";
import { SectionHeading } from "@/components/section-heading";
import { Reveal } from "@/components/reveal";
import { Badge } from "@/components/badge";

/**
 * Offline-first (§22) — the field-device sync story.
 */
const STEPS = [
  { icon: WifiOff, label: "No internet", note: "field device, on site" },
  { icon: Database, label: "Local data", note: "captured & stored" },
  { icon: Wifi, label: "4G returns", note: "any connection counts" },
  { icon: Upload, label: "Sync", note: "queued items upload" },
  { icon: Cloud, label: "Cloud", note: "record joins the project" },
] as const;

export function Offline() {
  return (
    <section aria-labelledby="offline-heading" className="border-b border-ink/10 bg-paper">
      <Container className="py-20 lg:py-28">
        <div className="grid items-center gap-12 lg:grid-cols-[1fr_1.1fr] lg:gap-16">
          <div>
            <SectionHeading
              eyebrow="Offline-first"
              title={<span id="offline-heading">Built for the site, not just the office.</span>}
              description="Construction sites sit exactly where connectivity is worst. MjengoOS captures attendance, photos, deliveries and site reports on the device — and syncs when the network comes back. No data held hostage by a signal bar."
            />
            <Reveal delay={140} className="mt-8">
              <div className="flex flex-wrap gap-2.5">
                <Badge tone="forest">Attendance offline</Badge>
                <Badge tone="forest">Photos offline</Badge>
                <Badge tone="forest">Deliveries offline</Badge>
                <Badge tone="forest">Daily report offline</Badge>
              </div>
            </Reveal>
          </div>

          {/* Sync diagram */}
          <Reveal delay={100} className="min-w-0">
            <div className="rounded-xl border border-ink/10 bg-white p-6 shadow-[0_24px_64px_-28px_rgb(23_25_24/0.3)] sm:p-8">
              {/* Field device */}
              <div className="rounded-lg border-2 border-dashed border-ink/20 bg-paper p-4">
                <div className="flex items-center justify-between">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-ink-mute">Field device</p>
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

              {/* Flow */}
              <ol className="mt-6 flex items-start justify-between gap-1" aria-label="Offline sync flow">
                {STEPS.map((s, i) => (
                  <li key={s.label} className="flex flex-1 flex-col items-center text-center">
                    <span className="flex h-10 w-10 items-center justify-center rounded-full bg-forest-50 text-forest-700 ring-1 ring-forest-100">
                      <s.icon className="h-4.5 w-4.5" aria-hidden />
                    </span>
                    <p className="mt-2 text-[11.5px] font-semibold text-ink">{s.label}</p>
                    <p className="mt-0.5 hidden text-[10px] leading-tight text-ink-mute sm:block">{s.note}</p>
                    {i < STEPS.length - 1 && (
                      <span aria-hidden className="hidden" />
                    )}
                  </li>
                ))}
              </ol>

              <div className="mt-6 rounded-lg bg-verified-soft px-4 py-3 text-center">
                <p className="flex items-center justify-center gap-2 text-[13px] font-semibold text-verified">
                  <Wifi className="h-4 w-4" aria-hidden />
                  4G returns at 17:42 — 33 records sync, ledger updated
                </p>
                <p className="mt-1 text-[11.5px] text-ink-mute">
                  Financial data never serves from cache — only the app's own captured outbox.
                </p>
              </div>
            </div>
          </Reveal>
        </div>
      </Container>
    </section>
  );
}

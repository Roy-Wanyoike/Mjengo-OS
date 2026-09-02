import { Globe, BellRing, CheckCircle2, AlertTriangle, Camera } from "lucide-react";
import { PageSection } from "@/components/page-hero";
import { SectionHeading } from "@/components/section-heading";
import { Reveal } from "@/components/reveal";
import { DemoChip } from "@/components/badge";
import { Counter } from "@/components/counter";
import { asset, formatKES } from "@/lib/utils";

/**
 * /projects — remote monitoring: the client's read-only window into the
 * project. KPI cards, latest site photos and the activity strip
 * (remote-monitoring.tsx concepts, §17).
 */
const PHOTOS = [
  { src: asset("/images/ground-truth.jpg"), alt: "Walling phase with formwork for the ring beam", caption: "Day 47 · walling" },
  { src: asset("/images/site-photo.jpg"), alt: "General site works during the structure phase", caption: "Day 44 · site" },
  { src: asset("/images/fundis.jpg"), alt: "Fundis working on the structure phase of the build", caption: "Day 39 · fundis" },
] as const;

export function MonitoringDashboard() {
  return (
    <PageSection tone="paper" ariaLabel="Remote project monitoring">
      <div className="grid items-center gap-12 lg:grid-cols-[0.95fr_1.05fr] lg:gap-14">
        {/* Copy */}
        <div>
          <SectionHeading
            eyebrow="Remote monitoring"
            title="Your project is in Nairobi. You don't have to be."
            description="The client's window shows the same record the site team keeps — progress anchored to dated, geolocated photos, budget anchored to the ledger, and approvals that wait for the client, not for a phone call."
          />
          <ul className="mt-8 space-y-4">
            {[
              "Share-link access — read-only, no account needed for viewing",
              "Alerts when something needs attention, not when it's too late",
              "Every KPI traceable to the evidence behind it",
            ].map((point, i) => (
              <Reveal as="li" key={point} delay={i * 70} className="flex items-start gap-3">
                <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-verified" aria-hidden />
                <span className="text-[15px] leading-relaxed text-ink-soft">{point}</span>
              </Reveal>
            ))}
          </ul>
          <Reveal delay={240}>
            <p className="mt-6 flex items-center gap-1.5 text-[13px] text-ink-mute">
              <Globe className="h-4 w-4 text-forest-600" aria-hidden />
              Works from any browser — the view, not the data, travels.
            </p>
          </Reveal>
        </div>

        {/* Client dashboard mockup */}
        <Reveal delay={100} className="min-w-0">
          <div className="relative overflow-hidden rounded-xl border border-ink/10 bg-white shadow-[0_24px_64px_-28px_rgb(23_25_24/0.35)]">
            <div className="relative flex flex-wrap items-center justify-between gap-3 border-b border-ink/10 px-5 py-4">
              <div>
                <p className="text-[10.5px] font-semibold uppercase tracking-[0.16em] text-ink-mute">
                  Remote client view
                </p>
                <p className="mt-0.5 font-display text-lg font-semibold text-ink">Karen Residence</p>
              </div>
              <div className="flex items-center gap-2.5">
                <DemoChip />
                <span className="rounded-full bg-forest-50 px-2.5 py-1 text-[11px] font-medium text-forest-800 ring-1 ring-forest-100">
                  Read-only
                </span>
              </div>
            </div>

            {/* KPI cards */}
            <div className="relative grid gap-px bg-ink/10 sm:grid-cols-2">
              {[
                {
                  label: "Complete",
                  node: <Counter to={68} suffix="%" className="font-display text-3xl font-semibold text-ink" />,
                  hint: "photo-verified progress",
                },
                {
                  label: "Budget used",
                  node: <Counter to={54} suffix="%" className="font-display text-3xl font-semibold text-ink" />,
                  hint: `${formatKES(2300000)} of ${formatKES(4200000)}`,
                },
                {
                  label: "Schedule",
                  node: <span className="font-display text-3xl font-semibold text-verified">On track</span>,
                  hint: "roofing starts in 6 days",
                },
                {
                  label: "Next milestone",
                  node: <span className="font-display text-[26px] font-semibold text-ink">Roofing</span>,
                  hint: `${formatKES(650000)} on evidence`,
                },
              ].map((cell) => (
                <div key={cell.label} className="bg-white p-5">
                  <p className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-ink-mute">{cell.label}</p>
                  <p className="mt-2">{cell.node}</p>
                  <p className="mt-1 text-[12px] text-ink-mute">{cell.hint}</p>
                </div>
              ))}
            </div>

            {/* Latest site photos */}
            <div className="relative border-t border-ink/10 px-5 py-4">
              <p className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-ink-mute">
                Latest site photos
              </p>
              <div className="mt-2.5 grid grid-cols-3 gap-2.5">
                {PHOTOS.map((photo) => (
                  <figure key={photo.src} className="overflow-hidden rounded-lg border border-ink/10">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={photo.src}
                      alt={photo.alt}
                      className="aspect-[4/3] w-full object-cover"
                      loading="lazy"
                    />
                    <figcaption className="bg-paper px-2 py-1 font-mono text-[9.5px] uppercase tracking-wider text-ink-mute">
                      {photo.caption}
                    </figcaption>
                  </figure>
                ))}
              </div>
            </div>

            {/* Activity strip */}
            <div className="relative flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-ink/10 bg-paper px-5 py-3.5 text-[13px]">
              <span className="flex items-center gap-1.5 font-medium text-ink">
                <Camera className="h-4 w-4 text-forest-600" aria-hidden /> 5 new photos
              </span>
              <span className="flex items-center gap-1.5 font-medium text-ink">
                <CheckCircle2 className="h-4 w-4 text-verified" aria-hidden /> 2 approvals waiting
              </span>
              <span className="flex items-center gap-1.5 font-medium text-alert">
                <AlertTriangle className="h-4 w-4" aria-hidden /> 1 alert — cement usage anomaly
              </span>
              <span className="ml-auto flex items-center gap-1.5 text-ink-mute">
                <BellRing className="h-4 w-4" aria-hidden /> notified today 14:32
              </span>
            </div>
          </div>
        </Reveal>
      </div>
    </PageSection>
  );
}

import { Globe, BellRing, CheckCircle2, AlertTriangle, Camera } from "lucide-react";
import { Container } from "@/components/container";
import { SectionHeading } from "@/components/section-heading";
import { Reveal } from "@/components/reveal";
import { Button } from "@/components/button";
import { DemoChip } from "@/components/badge";
import { MapVisual } from "@/components/map-visual";
import { formatKES } from "@/lib/utils";
import { Counter } from "@/components/counter";

/**
 * Remote client monitoring (§17): "Your project is in Nairobi. You don't
 * have to be." — a remote client's read-only view of the project.
 */
export function RemoteMonitoring() {
  return (
    <section aria-labelledby="remote-heading" className="border-b border-ink/10 bg-paper-warm/60">
      <Container className="py-20 lg:py-28">
        <div className="grid items-center gap-12 lg:grid-cols-[1.05fr_1fr] lg:gap-16">
          {/* Copy + CTA */}
          <SectionHeading
            eyebrow="Remote project monitoring"
            title={<span id="remote-heading">Your project is in Nairobi. You don't have to be.</span>}
            description="Whether you're across town or across the world, see what is happening without waiting for a phone call or a spreadsheet. The same record the site team keeps — yours to read, whenever you want."
          />

          <Reveal delay={120}>
            <div className="flex flex-wrap gap-3">
              <Button href="/projects" size="md">
                See Project Monitoring
              </Button>
              <span className="inline-flex items-center gap-1.5 self-center text-[13px] text-ink-mute">
                <Globe className="h-4 w-4 text-forest-600" aria-hidden />
                Share-link access — no account needed for read-only view
              </span>
            </div>

            <ul className="mt-8 space-y-4">
              {[
                "Progress anchored to dated, geolocated photos",
                "Milestone approvals that wait for you — evidence attached",
                "Alerts when something needs attention, not when it's too late",
              ].map((point, i) => (
                <Reveal as="li" key={point} delay={i * 70} className="flex items-start gap-3">
                  <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-verified" aria-hidden />
                  <span className="text-[15px] leading-relaxed text-ink-soft">{point}</span>
                </Reveal>
              ))}
            </ul>
          </Reveal>
        </div>

        {/* Remote client dashboard (demo) */}
        <Reveal delay={150} className="mt-14">
          <div className="relative overflow-hidden rounded-xl border border-ink/10 bg-white shadow-[0_24px_64px_-28px_rgb(23_25_24/0.35)]">
            <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-forest-800 via-forest-500 to-earth-500" aria-hidden />
            <div className="absolute inset-0 opacity-30" aria-hidden>
              <MapVisual className="h-full w-full" />
            </div>

            <div className="relative flex flex-wrap items-center justify-between gap-3 border-b border-ink/10 px-5 py-4">
              <div>
                <p className="text-[10.5px] font-semibold uppercase tracking-[0.16em] text-ink-mute">Remote client view</p>
                <p className="mt-0.5 font-display text-lg font-semibold text-ink">Karen Residence</p>
              </div>
              <div className="flex items-center gap-2.5">
                <DemoChip />
                <span className="rounded-full bg-forest-50 px-2.5 py-1 text-[11px] font-medium text-forest-800 ring-1 ring-forest-100">
                  Read-only
                </span>
              </div>
            </div>

            <div className="relative grid gap-px bg-ink/10 sm:grid-cols-2 lg:grid-cols-4">
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
      </Container>
    </section>
  );
}

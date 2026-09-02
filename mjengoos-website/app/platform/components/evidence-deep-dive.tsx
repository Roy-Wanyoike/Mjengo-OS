import { MapPin, Clock, Camera, FileCheck2, CheckCircle2 } from "lucide-react";
import { PageSection } from "@/components/page-hero";
import { SectionHeading } from "@/components/section-heading";
import { Reveal } from "@/components/reveal";
import { DemoChip, VerificationBadge } from "@/components/badge";
import { asset } from "@/lib/utils";

/**
 * /platform deep dive 1 — evidence capture. The real ground-truth photo with
 * the product's capture metadata: GPS, timestamp, and the chain from photo to
 * project record. Demo-labelled (§49).
 */
const BULLETS = [
  {
    icon: Camera,
    title: "Any phone on site",
    text: "The supervisor's daily habit — one capture, no special hardware, works offline.",
  },
  {
    icon: MapPin,
    title: "Written at capture time",
    text: "GPS coordinates and timestamp are stamped when the photo is taken, not typed in later.",
  },
  {
    icon: FileCheck2,
    title: "Filed to the record",
    text: "Evidence attaches to the phase, the milestone and the day — it never lives in a chat thread again.",
  },
] as const;

export function EvidenceDeepDive() {
  return (
    <PageSection tone="paper" ariaLabel="Deep dive: evidence capture">
      <div className="grid items-center gap-12 lg:grid-cols-[1fr_1.1fr] lg:gap-16">
        {/* Copy */}
        <div>
          <SectionHeading
            eyebrow="Deep dive — Evidence"
            title="A photo that can prove where and when it was taken."
            description="Anyone can take a site photo. A MjengoOS photo carries its coordinates and timestamp into the project record — so “we finished the walling” becomes a checkable claim, not a message you take on faith."
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

        {/* Mockup: capture metadata + the evidence chain */}
        <Reveal delay={100} className="min-w-0">
          <div className="overflow-hidden rounded-xl border border-ink/10 bg-white shadow-[0_24px_64px_-28px_rgb(23_25_24/0.35)]">
            <div className="flex items-center justify-between border-b border-ink/10 bg-forest-900 px-5 py-4">
              <div>
                <p className="text-[10.5px] font-semibold uppercase tracking-[0.18em] text-earth-400">
                  Evidence capture
                </p>
                <p className="mt-0.5 font-display text-lg font-semibold text-forest-50">
                  Karen Residence · Day 47
                </p>
              </div>
              <DemoChip className="border-forest-700 bg-forest-950/60 text-forest-300" />
            </div>

            {/* Photo with capture overlays */}
            <figure className="relative">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={asset("/images/ground-truth.jpg")}
                alt="Construction site in Kenya — workers on a walling phase with formwork and scaffolding"
                className="aspect-[4/3] w-full object-cover"
                loading="lazy"
              />
              <div className="absolute left-3 top-3 flex flex-wrap gap-2">
                <span className="flex items-center gap-1.5 rounded-md bg-ink/75 px-2.5 py-1 font-mono text-[10.5px] text-white backdrop-blur-sm">
                  <MapPin className="h-3 w-3 text-earth-400" aria-hidden /> -1.3190, 36.7765
                </span>
                <span className="flex items-center gap-1.5 rounded-md bg-ink/75 px-2.5 py-1 font-mono text-[10.5px] text-white backdrop-blur-sm">
                  <Clock className="h-3 w-3 text-earth-400" aria-hidden /> Day 47 · 14:32 EAT
                </span>
              </div>
              <div className="absolute inset-x-3 bottom-3 flex items-center justify-between gap-2">
                <span className="rounded-md bg-forest-900/85 px-2.5 py-1 text-[11px] font-medium text-forest-50 backdrop-blur-sm">
                  Walling — East elevation
                </span>
                <span className="hidden rounded-md bg-earth-500/95 px-2.5 py-1 text-[11px] font-semibold text-ink backdrop-blur-sm sm:inline-flex">
                  Photo 12 of 12
                </span>
              </div>
            </figure>

            {/* Capture → record chain */}
            <ol
              className="grid grid-cols-4 divide-x divide-ink/10 border-t border-ink/10"
              aria-label="From capture to the project record"
            >
              {[
                { icon: Camera, label: "Photo", note: "on site" },
                { icon: MapPin, label: "GPS", note: "-1.3190, 36.7765" },
                { icon: Clock, label: "Timestamp", note: "14:32 EAT" },
                { icon: FileCheck2, label: "Record", note: "Day 47 file" },
              ].map((step) => (
                <li key={step.label} className="flex flex-col items-center px-2 py-3.5 text-center">
                  <step.icon className="h-4 w-4 text-forest-600" aria-hidden />
                  <p className="mt-1.5 text-[12px] font-semibold text-ink">{step.label}</p>
                  <p className="mt-0.5 hidden font-mono text-[10px] text-ink-mute sm:block">{step.note}</p>
                </li>
              ))}
            </ol>

            {/* Milestone attachment */}
            <div className="flex flex-wrap items-center justify-between gap-2.5 border-t border-ink/10 bg-paper px-5 py-3.5">
              <p className="flex items-center gap-2 text-[13px] font-medium text-ink">
                <CheckCircle2 className="h-4 w-4 text-verified" aria-hidden />
                Attached to milestone — Walling to ring beam
              </p>
              <VerificationBadge state="verified" label="Evidence on record" />
            </div>
          </div>
        </Reveal>
      </div>
    </PageSection>
  );
}

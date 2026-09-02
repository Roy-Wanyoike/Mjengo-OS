import { Eye } from "lucide-react";
import { Reveal } from "@/components/reveal";
import { DemoChip, Badge } from "@/components/badge";
import { asset } from "@/lib/utils";

/**
 * /ai — SEE: photo-based progress analysis. Foundation (Day 18) vs
 * ground-truth walls (Day 47) with the 82% chip, confidence state and
 * the human-review recommendation (§27).
 */
export function CapabilitySee() {
  return (
    <Reveal className="h-full">
      <article className="flex h-full min-w-0 flex-col overflow-hidden rounded-xl border border-ink/10 bg-white shadow-[0_24px_64px_-28px_rgb(23_25_24/0.3)]">
        <div className="flex items-center gap-3.5 border-b border-ink/10 px-5 py-4">
          <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-forest-800 text-forest-50">
            <Eye className="h-5 w-5" aria-hidden />
          </span>
          <div>
            <h3 className="font-display text-[17px] font-semibold uppercase tracking-wide text-ink">See</h3>
            <p className="text-[12px] text-ink-mute">Photo-based progress analysis</p>
          </div>
        </div>

        <div className="flex flex-1 flex-col">
          <div className="grid flex-1 gap-px bg-ink/10 sm:grid-cols-2">
            <div className="bg-white p-4">
              <p className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-ink-mute">
                Before · Day 18
              </p>
              <div className="mt-2 overflow-hidden rounded-lg">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={asset("/images/foundation.jpg")}
                  alt="Foundation phase of a building under construction with formwork"
                  className="aspect-[4/3] w-full object-cover"
                  loading="lazy"
                />
              </div>
              <p className="mt-2 text-[12.5px] font-medium text-ink">Foundation</p>
            </div>
            <div className="bg-white p-4">
              <p className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-ink-mute">
                Current · Day 47
              </p>
              <div className="relative mt-2 overflow-hidden rounded-lg">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={asset("/images/ground-truth.jpg")}
                  alt="Ground floor walls substantially complete with formwork for the ring beam"
                  className="aspect-[4/3] w-full object-cover"
                  loading="lazy"
                />
                <span className="absolute right-2 top-2 rounded-md bg-earth-500 px-2 py-0.5 text-[10.5px] font-bold text-ink">
                  82%
                </span>
              </div>
              <p className="mt-2 text-[12.5px] font-medium text-ink">Ground floor walls</p>
            </div>
          </div>

          <div className="border-t border-ink/10 bg-forest-50/60 px-5 py-4">
            <div className="flex items-center justify-between gap-2">
              <p className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-forest-800">
                <Eye className="h-4 w-4" aria-hidden /> AI observation
              </p>
              <DemoChip />
            </div>
            <p className="mt-1.5 text-[13.5px] leading-relaxed text-ink-soft">
              Walls appear substantially complete. Formwork visible for ring beam — the next phase is
              likely ready to schedule.
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2.5">
              <Badge tone="caution">Confidence: Medium</Badge>
              <span className="text-[12px] text-ink-mute">Human review recommended</span>
            </div>
          </div>
        </div>
      </article>
    </Reveal>
  );
}

import { Ear, Mic, ArrowRight } from "lucide-react";
import { Reveal } from "@/components/reveal";
import { DemoChip, Badge } from "@/components/badge";

/**
 * /ai — LISTEN: a Swahili voice note transformed into a structured
 * record. Waveform, transcription, draft record cards (§28).
 */
export function CapabilityListen() {
  return (
    <Reveal delay={80} className="h-full">
      <article className="flex h-full min-w-0 flex-col overflow-hidden rounded-xl border border-ink/10 bg-white shadow-[0_24px_64px_-28px_rgb(23_25_24/0.3)]">
        <div className="flex items-center gap-3.5 border-b border-ink/10 px-5 py-4">
          <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-forest-800 text-forest-50">
            <Ear className="h-5 w-5" aria-hidden />
          </span>
          <div>
            <h3 className="font-display text-[17px] font-semibold uppercase tracking-wide text-ink">Listen</h3>
            <p className="text-[12px] text-ink-mute">Voice notes → structured records</p>
          </div>
        </div>

        <div className="flex flex-1 flex-col px-5 py-4">
          <div className="flex items-center gap-3 rounded-lg bg-forest-900 px-4 py-3">
            <Mic className="h-5 w-5 shrink-0 text-earth-400" aria-hidden />
            <div className="flex h-8 items-end gap-[3px]" aria-hidden>
              {[6, 12, 8, 16, 10, 20, 14, 9, 18, 12, 7, 15, 11, 6, 13, 8].map((h, i) => (
                <span key={i} className="w-[3px] rounded-full bg-earth-400/80" style={{ height: `${h * 2}px` }} />
              ))}
            </div>
            <span className="ml-auto font-mono text-[10.5px] text-forest-300">0:08</span>
            <Badge tone="dark" className="border-forest-700 text-[10px]">Swahili</Badge>
          </div>

          <p className="mt-3 text-[14px] italic leading-relaxed text-ink-soft">
            &ldquo;Nimepokea 20 bags za cement na 5 rolls za wire kutoka Karioke Hardware&hellip;&rdquo;
          </p>

          <ArrowRight className="mt-3 h-4 w-4 text-ink-faint" aria-hidden />

          <dl className="mt-3 grid flex-1 gap-2 text-[13.5px] sm:grid-cols-2">
            {[
              ["Materials", "20 × cement · 5 × binding wire"],
              ["Supplier", "Karioke Hardware"],
              ["Project", "Karen Residence"],
              ["Status", "Draft — review required"],
            ].map(([k, v]) => (
              <div key={k} className="rounded-lg border border-ink/10 bg-paper px-3.5 py-2.5">
                <dt className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-mute">{k}</dt>
                <dd className="mt-0.5 font-medium text-ink">{v}</dd>
              </div>
            ))}
          </dl>

          <div className="mt-4 flex items-start justify-between gap-3 border-t border-ink/10 pt-3.5">
            <p className="text-[11.5px] leading-relaxed text-ink-mute">
              The site team speaks; MjengoOS drafts the record. A human confirms before it becomes project
              data.
            </p>
            <DemoChip className="shrink-0" />
          </div>
        </div>
      </article>
    </Reveal>
  );
}

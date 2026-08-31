import { Languages, WifiOff, Signal, BookOpen } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { PageSection } from "@/components/page-hero";
import { SectionHeading } from "@/components/section-heading";
import { Reveal } from "@/components/reveal";

/**
 * /ai — built for African sites: Swahili/Sheng voice parsing,
 * offline-tolerance, low-bandwidth photos, local vocabulary.
 */
const POINTS: { icon: LucideIcon; title: string; text: string }[] = [
  {
    icon: Languages,
    title: "Swahili & Sheng parsing",
    text: "Voice notes arrive in Swahili, Sheng and everything between. The LISTEN path is built for how sites actually speak — not for a demo tape.",
  },
  {
    icon: WifiOff,
    title: "Offline-tolerant",
    text: "Photos and voice notes captured with no network sit in the outbox; AI processes them when connectivity returns. The field day never waits on 4G.",
  },
  {
    icon: Signal,
    title: "Low-bandwidth photos",
    text: "Compressed captures, not 12-megapixel uploads. Built for patchy coverage and prepaid data — evidence that survives a 2G day.",
  },
  {
    icon: BookOpen,
    title: "Local vocabulary",
    text: "Bags, trips, deformed bars, BRC mesh, fundi trades, ring beams — the words Kenyan sites actually use, understood natively.",
  },
];

export function AfricaBuilt() {
  return (
    <PageSection tone="warm" ariaLabel="Built for African sites">
      <SectionHeading
        eyebrow="Built for African sites"
        title="Not adapted to the region. Designed in it."
        description="Most construction AI is trained on assumptions that dissolve at the site gate. This one assumes the gate: the language, the network, the data budget and the vocabulary of an East African build."
      />

      <div className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
        {POINTS.map((p, i) => (
          <Reveal key={p.title} delay={i * 70}>
            <article className="h-full rounded-xl border border-ink/10 bg-white p-5">
              <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-forest-50 text-forest-700 ring-1 ring-forest-100">
                <p.icon className="h-4.5 w-4.5" aria-hidden />
              </span>
              <h3 className="mt-3 font-display text-[16px] font-semibold leading-tight text-ink">{p.title}</h3>
              <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-mute">{p.text}</p>
            </article>
          </Reveal>
        ))}
      </div>
    </PageSection>
  );
}

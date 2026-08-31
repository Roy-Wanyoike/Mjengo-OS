import { Images, Wallet, ScrollText, ShieldCheck } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { PageSection } from "@/components/page-hero";
import { SectionHeading } from "@/components/section-heading";
import { Reveal } from "@/components/reveal";
import { Badge } from "@/components/badge";

/**
 * /projects — the project record artifacts at handover: photo timeline,
 * financial ledger, decisions log, verification passport (§31).
 */
const ARTIFACTS: { icon: LucideIcon; title: string; text: string; answers: string }[] = [
  {
    icon: Images,
    title: "Photo timeline",
    text: "Every dated, geolocated photo from groundbreaking to the final coat — the visual history of the build, in order.",
    answers: "Answers: \u201cWhat did it actually look like, and when?\u201d",
  },
  {
    icon: Wallet,
    title: "Financial ledger",
    text: "The complete append-only record — every shilling with its actor, timestamp, note and M-Pesa reference.",
    answers: "Answers: \u201cWhere did the money go, exactly?\u201d",
  },
  {
    icon: ScrollText,
    title: "Decisions log",
    text: "Variations, approvals and rejections — who decided, when, and the note they left explaining it.",
    answers: "Answers: \u201cWho changed what, and why?\u201d",
  },
  {
    icon: ShieldCheck,
    title: "Verification passport",
    text: "Land verification states, professional reports and licence references — the trust history of the parcel and the people on it.",
    answers: "Answers: \u201cWhat was checked, and by whom?\u201d",
  },
];

export function HandoverArtifacts() {
  return (
    <PageSection tone="warm" ariaLabel="Project record artifacts at handover">
      <SectionHeading
        eyebrow="Handover"
        title="The keys, and the record."
        description="Completion hands over more than a building. Four artifacts leave with the project — exports in open formats, because the record belongs to the project, not to the platform."
      />

      <div className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
        {ARTIFACTS.map((a, i) => (
          <Reveal key={a.title} delay={i * 70} className="h-full">
            <article className="flex h-full flex-col rounded-xl border border-ink/10 bg-white p-6">
              <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-forest-800 text-forest-50">
                <a.icon className="h-5 w-5" aria-hidden />
              </span>
              <h3 className="mt-4 font-display text-[17px] font-semibold text-ink">{a.title}</h3>
              <p className="mt-2 flex-1 text-[13.5px] leading-relaxed text-ink-mute">{a.text}</p>
              <p className="mt-4 border-t border-ink/10 pt-3.5 text-[12px] italic leading-snug text-ink-soft">
                {a.answers}
              </p>
            </article>
          </Reveal>
        ))}
      </div>

      <Reveal delay={320}>
        <div className="mt-8 flex flex-wrap items-center justify-between gap-4 rounded-xl border border-ink/10 bg-white px-5 py-4">
          <p className="max-w-2xl text-[14px] leading-relaxed text-ink-soft">
            Years later — a dispute, a sale, a renovation, an insurance claim — the record still answers.
            That is what &ldquo;tracked&rdquo; was always for.
          </p>
          <Badge tone="forest">
            <span className="font-mono text-[10px] tracking-wider">4 ARTIFACTS · OPEN FORMATS</span>
          </Badge>
        </div>
      </Reveal>
    </PageSection>
  );
}

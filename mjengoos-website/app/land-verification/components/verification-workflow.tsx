import { FolderOpen, ScanSearch, MapPinned, Camera, Scale, ChevronRight } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { PageSection } from "@/components/page-hero";
import { SectionHeading } from "@/components/section-heading";
import { Reveal } from "@/components/reveal";
import { VerificationBadge } from "@/components/badge";

/**
 * /land-verification — the five-stage verification workflow plus the honest
 * state ladder (§18). MjengoOS organizes the workflow and connects
 * professionals; official verification stays with the registry and lawyers.
 */
const STAGES: { icon: LucideIcon; title: string; note: string }[] = [
  {
    icon: FolderOpen,
    title: "Documents collected",
    note: "Title deed, survey plan, mutation forms — uploaded once, attached to the parcel record.",
  },
  {
    icon: ScanSearch,
    title: "Official search",
    note: "A registry search is obtained and attached to the record — the parcel's official standing, on file.",
  },
  {
    icon: MapPinned,
    title: "Survey verification",
    note: "Beacons and boundaries re-established on the ground by a licensed surveyor — differences documented.",
  },
  {
    icon: Camera,
    title: "Physical inspection",
    note: "The parcel walked and photographed — what exists on the ground, stamped with GPS and time.",
  },
  {
    icon: Scale,
    title: "Legal review",
    note: "A lawyer's opinion on title and encumbrances — recorded in plain language, attached to the file.",
  },
];

/** The honest state ladder — the last rung is explicitly not MjengoOS's. */
const LADDER: {
  label: string;
  state: "none" | "pending" | "verified" | "outside";
  note: string;
}[] = [
  { label: "Submitted", state: "none", note: "documents on file" },
  { label: "Reviewed", state: "pending", note: "checked against the record" },
  { label: "Professionally verified", state: "verified", note: "a licensed professional did the work" },
  { label: "Officially verified", state: "outside", note: "registry & lawyer domain — not MjengoOS" },
];

export function VerificationWorkflow() {
  return (
    <PageSection tone="paper" ariaLabel="The verification workflow">
      <SectionHeading
        eyebrow="The workflow"
        title="Five stages, in the open."
        description="MjengoOS organizes this sequence and connects the professionals who do the work. It never claims to be the registry — official verification stays where it belongs: with the government bodies and your lawyer."
      />

      {/* The five stages */}
      <Reveal delay={140} className="mt-12">
        <ol className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5" aria-label="Five verification stages">
          {STAGES.map((stage, i) => (
            <li key={stage.title} className="group relative rounded-xl border border-ink/10 bg-white p-5 transition-colors hover:border-forest-300">
              <span className="font-mono text-[10px] font-bold tracking-[0.18em] text-earth-600">
                {String(i + 1).padStart(2, "0")}
              </span>
              <div className="mt-3 flex h-9 w-9 items-center justify-center rounded-lg bg-forest-50 text-forest-700 ring-1 ring-forest-100">
                <stage.icon className="h-4.5 w-4.5" aria-hidden />
              </div>
              <h3 className="mt-3 font-display text-[16px] font-semibold leading-tight text-ink">{stage.title}</h3>
              <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-mute">{stage.note}</p>
            </li>
          ))}
        </ol>
      </Reveal>

      {/* The honest state ladder */}
      <Reveal delay={200} className="mt-10">
        <div className="overflow-hidden rounded-xl border border-ink/10 bg-forest-950">
          <div className="border-b border-forest-800 px-5 py-3.5">
            <p className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.18em] text-earth-400">
              The state ladder — every check lands on one rung
            </p>
          </div>
          <div className="flex flex-col gap-3 px-5 py-5 sm:flex-row sm:items-center">
            {LADDER.map((rung, i) => (
              <div key={rung.label} className="flex flex-1 items-center gap-3">
                <div
                  className={
                    rung.state === "outside"
                      ? "flex-1 rounded-lg border border-dashed border-forest-700 bg-transparent px-4 py-3"
                      : "flex-1 rounded-lg border border-forest-700 bg-forest-900/70 px-4 py-3"
                  }
                >
                  {rung.state === "outside" ? (
                    <p className="text-[13.5px] font-semibold text-forest-300/90">{rung.label}</p>
                  ) : (
                    <VerificationBadge state={rung.state} label={rung.label} />
                  )}
                  <p className="mt-1.5 text-[11.5px] leading-snug text-forest-300/75">{rung.note}</p>
                </div>
                {i < LADDER.length - 1 && (
                  <ChevronRight className="hidden h-4 w-4 shrink-0 text-forest-600 sm:block" aria-hidden />
                )}
              </div>
            ))}
          </div>
          <p className="border-t border-forest-800 bg-forest-900/50 px-5 py-3 text-[11.5px] leading-relaxed text-forest-300/75">
            We never blur the last rung. &ldquo;Officially verified&rdquo; is something the registry or a lawyer can
            say — MjengoOS records their work, and the difference between the rungs stays yours to see.
          </p>
        </div>
      </Reveal>
    </PageSection>
  );
}

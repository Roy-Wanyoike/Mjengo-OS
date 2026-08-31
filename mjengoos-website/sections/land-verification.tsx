import { AlertTriangle, FileCheck2, ScanSearch, Landmark, MapPinned, UserRoundCheck } from "lucide-react";
import { Container } from "@/components/container";
import { SectionHeading } from "@/components/section-heading";
import { Reveal } from "@/components/reveal";
import { Button } from "@/components/button";
import { DemoChip, VerificationBadge } from "@/components/badge";
import type { VerificationState } from "@/types";

/**
 * Land verification (§18) — the Property Passport.
 * Honest language: MjengoOS organizes the verification workflow and connects
 * clients with verified professionals. NO claims of government verification.
 */
const PASSPORT_ROWS: {
  icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  field: string;
  state: VerificationState;
  label: string;
  note: string;
}[] = [
  { icon: Landmark, field: "Ownership", state: "verified", label: "Checked", note: "title deed on record" },
  { icon: ScanSearch, field: "Registry", state: "verified", label: "Searched", note: "official search attached" },
  { icon: MapPinned, field: "Survey", state: "verified", label: "Verified", note: "beacons confirmed on site" },
  { icon: UserRoundCheck, field: "Physical inspection", state: "verified", label: "Completed", note: "site visit documented" },
  { icon: FileCheck2, field: "Encumbrances", state: "caution", label: "Review required", note: "caveat on record" },
  { icon: UserRoundCheck, field: "Surveyor", state: "verified", label: "Verified professional", note: "licence checked" },
];

export function LandVerification() {
  return (
    <section aria-labelledby="land-heading" className="border-b border-ink/10 bg-paper">
      <Container className="py-20 lg:py-28">
        <div className="grid items-center gap-12 lg:grid-cols-[1fr_1.05fr] lg:gap-16">
          <div>
            <SectionHeading
              eyebrow="Land verification"
              title={<span id="land-heading">Before you build, know what you're building on.</span>}
              description="MjengoOS organizes the property verification workflow — documents, searches, surveys, inspections — and connects you with verified professionals to do the work."
            />

            <Reveal delay={120}>
              <div className="mt-8 rounded-xl border border-ink/10 bg-white p-5">
                <p className="text-[10.5px] font-semibold uppercase tracking-[0.16em] text-ink-mute">
                  Every verification state is explicit
                </p>
                <div className="mt-3 flex flex-wrap gap-2.5">
                  <VerificationBadge state="none" label="Submitted" />
                  <VerificationBadge state="pending" label="Reviewed" />
                  <VerificationBadge state="caution" label="Discrepancy flagged" />
                  <VerificationBadge state="verified" label="Professionally verified" />
                </div>
                <p className="mt-4 text-[13.5px] leading-relaxed text-ink-mute">
                  MjengoOS never claims a plot is <em>officially</em> verified. We record who checked
                  what, when, and against which document — the difference between submitted,
                  reviewed, professionally verified and officially verified stays yours to see.
                </p>
              </div>
            </Reveal>

            <Reveal delay={180} className="mt-7">
              <Button href="/land-verification" variant="secondary">
                Explore Land Verification
              </Button>
            </Reveal>
          </div>

          {/* Property Passport */}
          <Reveal delay={100} className="min-w-0">
            <div className="overflow-hidden rounded-xl border border-ink/10 bg-white shadow-[0_24px_64px_-28px_rgb(23_25_24/0.35)]">
              <div className="flex items-center justify-between border-b border-ink/10 bg-forest-900 px-5 py-4">
                <div>
                  <p className="text-[10.5px] font-semibold uppercase tracking-[0.18em] text-earth-400">
                    Property passport
                  </p>
                  <p className="mt-0.5 font-display text-lg font-semibold text-forest-50">
                    Parcel 209/12345 · Karen, Nairobi
                  </p>
                </div>
                <DemoChip className="border-forest-700 bg-forest-950/60 text-forest-300" />
              </div>

              <ul className="divide-y divide-ink/10">
                {PASSPORT_ROWS.map((row, i) => (
                  <Reveal as="li" key={row.field} delay={i * 60}>
                    <div className="flex items-center gap-4 px-5 py-3.5">
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-forest-50 text-forest-700 ring-1 ring-forest-100">
                        <row.icon className="h-4.5 w-4.5" aria-hidden />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="text-[14.5px] font-semibold text-ink">{row.field}</p>
                        <p className="text-[12px] text-ink-mute">{row.note}</p>
                      </div>
                      <VerificationBadge state={row.state} label={row.label} />
                    </div>
                  </Reveal>
                ))}
              </ul>

              <p className="border-t border-ink/10 bg-paper px-5 py-3 text-[11.5px] leading-relaxed text-ink-mute">
                Compiled from records in MjengoOS. Not a government certificate — a transparent
                account of what has been checked, by whom, and what still needs review.
              </p>
            </div>
          </Reveal>
        </div>

        {/* Honest caveat row */}
        <Reveal delay={140} className="mt-10">
          <div className="flex items-start gap-3 rounded-lg border border-caution/30 bg-caution-soft px-4 py-3.5">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-caution" aria-hidden />
            <p className="text-[13.5px] leading-relaxed text-ink-soft">
              A caveat on record is a fact, not a verdict. MjengoOS surfaces it for professional
              review — the resolution belongs to your lawyer and the registry, and the record
              follows the outcome.
            </p>
          </div>
        </Reveal>
      </Container>
    </section>
  );
}

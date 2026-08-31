import { Landmark, ScanSearch, MapPinned, Camera, AlertTriangle, Scale } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { PageSection } from "@/components/page-hero";
import { SectionHeading } from "@/components/section-heading";
import { Reveal } from "@/components/reveal";
import { DemoChip, VerificationBadge } from "@/components/badge";
import type { VerificationState } from "@/types";

/**
 * /land-verification — the Property Passport, richer than the homepage's
 * version: parcel particulars, six verification rows with who/when detail,
 * an encumbrances caveat banner and the honesty footer (§18).
 */
const PASSPORT_ROWS: {
  icon: LucideIcon;
  field: string;
  note: string;
  state: VerificationState;
  label: string;
}[] = [
  { icon: Landmark, field: "Ownership", note: "Title deed on file · matches parcel particulars", state: "verified", label: "Checked" },
  { icon: ScanSearch, field: "Registry search", note: "Official search attached · dated 12 Jun 2026", state: "verified", label: "Attached" },
  { icon: MapPinned, field: "Survey & beacons", note: "Licensed surveyor · beacons 1–4 confirmed", state: "verified", label: "Confirmed" },
  { icon: Camera, field: "Physical inspection", note: "12 geolocated photos · occupation documented", state: "verified", label: "Documented" },
  { icon: AlertTriangle, field: "Encumbrances", note: "Caveat on record · registered 2024", state: "caution", label: "Review required" },
  { icon: Scale, field: "Legal review", note: "Advocate reviewing search & caveat", state: "pending", label: "In progress" },
];

export function PropertyPassport() {
  return (
    <PageSection tone="warm" ariaLabel="The Property Passport">
      <div className="grid items-center gap-12 lg:grid-cols-[1fr_1.08fr] lg:gap-16">
        {/* Copy */}
        <div>
          <SectionHeading
            eyebrow="The Property Passport"
            title="One page for the state of the land."
            description="Not a folder of PDFs that goes missing between WhatsApp threads — a living page on the parcel: every check recorded with who did it, when, and against which document."
          />
          <ul className="mt-8 space-y-4">
            {[
              "States at a glance — checked, pending, flagged, in progress. Nothing hides behind a summary.",
              "Encumbrances surfaced, not buried — a caveat appears the moment the record shows it.",
              "Professional reports attached — the surveyor's plan, the lawyer's opinion, filed to the parcel.",
            ].map((point, i) => (
              <Reveal as="li" key={point} delay={i * 70} className="flex items-start gap-3">
                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-earth-500" aria-hidden />
                <span className="text-[15px] leading-relaxed text-ink-soft">{point}</span>
              </Reveal>
            ))}
          </ul>
        </div>

        {/* Property Passport mockup */}
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

            {/* Parcel particulars strip */}
            <div className="flex flex-wrap gap-x-6 gap-y-1.5 border-b border-ink/10 bg-paper px-5 py-3 font-mono text-[11px] text-ink-mute">
              <span>LR No. IR 209/12345</span>
              <span>Approx. 0.4 ha</span>
              <span>Updated 14 May 2026</span>
            </div>

            {/* Verification rows */}
            <ul className="divide-y divide-ink/10">
              {PASSPORT_ROWS.map((row, i) => (
                <Reveal as="li" key={row.field} delay={i * 50}>
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

            {/* Encumbrances caveat banner */}
            <div className="border-t border-caution/25 bg-caution-soft px-5 py-3.5">
              <p className="flex items-start gap-2.5 text-[12.5px] leading-relaxed text-ink-soft">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-caution" aria-hidden />
                <span>
                  <strong className="font-semibold">1 encumbrance on record</strong> — a caveat registered 2024. A
                  fact, not a verdict: it is flagged for legal review, and the registry and your lawyer resolve it.
                  The record follows the outcome.
                </span>
              </p>
            </div>

            {/* Honesty footer */}
            <p className="border-t border-ink/10 bg-paper px-5 py-3 text-[11.5px] leading-relaxed text-ink-mute">
              Compiled from records in MjengoOS — who checked what, when, against which document. Not a
              government certificate; the registry remains authoritative.
            </p>
          </div>
        </Reveal>
      </div>
    </PageSection>
  );
}

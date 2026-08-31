import { AlertTriangle, Layers } from "lucide-react";
import { PageSection } from "@/components/page-hero";
import { SectionHeading } from "@/components/section-heading";
import { Reveal } from "@/components/reveal";

/**
 * /wallet — the honesty band (critical): NOT a bank, holds no deposits,
 * no regulatory claims — records payments made by people. Plus: the
 * wallet architecture designed as reusable project-scoped financial
 * infrastructure (§25).
 */
export function HonestyBand() {
  return (
    <PageSection tone="dark" ariaLabel="What the wallet is not">
      <div className="grid items-start gap-12 lg:grid-cols-[1.1fr_0.9fr] lg:gap-16">
        <div>
          <SectionHeading
            dark
            eyebrow="Read this part carefully"
            title="The wallet is a ledger — not a bank."
            description="Nothing about MjengoOS is a financial institution, and we will never describe it that way."
          />
          <ul className="mt-8 space-y-4">
            {[
              "MjengoOS holds no deposits. Money never sits with the platform.",
              "There is no escrow custody and no regulatory licence behind the wallet.",
              "Payments are made by people, through their own channels — MjengoOS records them: method, reference, timestamp, actor.",
              "If anyone tells you MjengoOS 'keeps' your project money, they have been misled — correct them with this page.",
            ].map((point, i) => (
              <Reveal as="li" key={point} delay={i * 70} className="flex items-start gap-3">
                <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-earth-400" aria-hidden />
                <span className="text-[15px] leading-relaxed text-forest-300/90">{point}</span>
              </Reveal>
            ))}
          </ul>
        </div>

        <Reveal delay={140}>
          <div className="rounded-xl border border-forest-800 bg-forest-950/70 p-6">
            <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-forest-900 text-earth-300">
              <Layers className="h-5 w-5" aria-hidden />
            </span>
            <h3 className="mt-4 font-display text-[17px] font-semibold text-forest-50">
              Built as infrastructure, deliberately
            </h3>
            <p className="mt-2.5 text-[13.5px] leading-relaxed text-forest-300/85">
              The wallet architecture is designed as reusable, project-scoped financial infrastructure — a
              ledger of commitments, approvals and payments that other applications can stand on. The
              discipline is the same everywhere: record what people did, never pretend to be the
              institution between them.
            </p>
            <p className="mt-4 font-mono text-[10.5px] uppercase tracking-[0.16em] text-forest-300/60">
              Record-keeping infrastructure · Not custody
            </p>
          </div>
        </Reveal>
      </div>
    </PageSection>
  );
}

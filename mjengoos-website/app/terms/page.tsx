import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Container } from "@/components/container";
import { Reveal } from "@/components/reveal";
import { SiteLink } from "@/components/site-link";
import { SITE } from "@/lib/site";

export const metadata: Metadata = {
  title: "Terms of Service",
  description:
    "The terms of service for MjengoOS — what the service is (and isn't), your data, acceptable use, professional and AI disclaimers, and Kenyan governing law.",
  alternates: { canonical: "/terms" },
};

const LAST_UPDATED = "31 August 2026";

export default function TermsPage() {
  return (
    <>
      {/* Compact hero */}
      <section className="relative overflow-hidden border-b border-ink/10 bg-paper-warm/70">
        <div className="absolute inset-0 bg-survey-grid" aria-hidden />
        <Container className="relative py-12 sm:py-14">
          <Reveal className="max-w-3xl">
            <p className="mb-2.5 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-earth-600">
              <span className="inline-block h-px w-6 bg-earth-500/70" aria-hidden />
              Legal
            </p>
            <h1 className="font-display text-3xl font-semibold leading-tight tracking-tight text-ink sm:text-4xl">
              Terms of Service
            </h1>
            <p className="mt-4 max-w-2xl text-[15px] leading-relaxed text-ink-mute">
              The agreement between you and MjengoOS. Written to be read — but
              it is still a contract, so read it.
            </p>
            <p className="mt-4 text-[13px] font-medium text-ink-mute">
              Last updated: {LAST_UPDATED}
            </p>
          </Reveal>
        </Container>
      </section>

      <Container className="max-w-3xl py-12 sm:py-16">
        <Reveal>
          <p className="text-[15px] leading-relaxed text-ink-soft">
            These terms govern your use of the MjengoOS website and application
            (together, &ldquo;MjengoOS&rdquo; or &ldquo;the service&rdquo;),
            operated from Kenya. By creating an account or using the service,
            you agree to them. If you use the service on behalf of an
            organization, you confirm you have authority to bind it.
          </p>

          <LegalSection n={1} title="Acceptance">
            <p>
              By creating an account, requesting access, or otherwise using
              MjengoOS, you accept these terms and our{" "}
              <SiteLink
                href="/privacy"
                className="font-medium text-forest-800 underline decoration-forest-800/30 underline-offset-4 hover:decoration-forest-800"
              >
                Privacy Policy
              </SiteLink>
              . If you don&apos;t accept them, don&apos;t use the service — and
              if you&apos;ve already started, you can export your project data
              and stop at any time.
            </p>
          </LegalSection>

          <LegalSection n={2} title="The service">
            <p>
              MjengoOS is project management and record-keeping software for
              construction projects: projects and milestones, evidence capture,
              attendance, budgeting and payment records, land verification
              workflows, approvals, notifications and AI-assisted analysis.
            </p>
            <p>
              <strong className="font-semibold text-ink">
                MjengoOS is not a bank or financial institution.
              </strong>{" "}
              It does not take deposits, hold client money in escrow, lend, or
              move funds. The &ldquo;wallet&rdquo; is a ledger: it records
              commitments, approvals, payments and their references. Money
              itself moves through your own bank and M-Pesa accounts, between
              the parties to your project — never through us.
            </p>
          </LegalSection>

          <LegalSection n={3} title="Your data & license">
            <p>
              Your project data — including photos, voice notes, documents,
              ledger entries and audit records — belongs to you and your
              project. We store and process it solely to operate the service
              for you. You grant us the limited license needed to host, back
              up, and process that data (including running the AI features you
              request); you do not grant us any right to sell it or share it
              outside a project.
            </p>
            <p>
              You may export your project data in open formats at any time,
              from the platform itself. We may use aggregate, de-identified
              patterns to improve the service — but your project record is not
              our product.
            </p>
          </LegalSection>

          <LegalSection n={4} title="Acceptable use">
            <p>You agree to use MjengoOS lawfully and honestly. Specifically:</p>
            <ul className="list-disc space-y-2 pl-5">
              <li>Provide accurate information for your account and projects.</li>
              <li>
                Upload only content you have the right to upload — including
                land documents, photos of sites and people, and worker records.
              </li>
              <li>
                Respect other users: don&apos;t attempt to access projects,
                accounts or data that aren&apos;t yours, and don&apos;t share
                your credentials.
              </li>
              <li>
                Don&apos;t probe, scrape, reverse-engineer or overload the
                service, or use it to break any law.
              </li>
            </ul>
            <p>
              Accounts or projects that put other users&apos; data or the
              service at risk may be suspended. Where it&apos;s safe and legal
              to do so, you&apos;ll get a warning and a chance to fix it first.
            </p>
          </LegalSection>

          <LegalSection n={5} title="Professional verification disclaimer">
            <p>
              Verification states shown in MjengoOS — land searches, registry
              checks, document reviews — are records of checks performed or
              recorded at a point in time. They are not guarantees of title,
              ownership, encumbrance status or professional qualification, and
              they do not replace professional due diligence. Official
              registries, licensed advocates, surveyors and other qualified
              professionals remain the authoritative sources for their
              respective matters. Engage them.
            </p>
          </LegalSection>

          <LegalSection n={6} title="AI output disclaimer">
            <p>
              AI features — photo observations, voice transcription, anomaly
              flags, summaries — produce advisory output that can be wrong,
              incomplete or misread context. AI output is a starting point for
              human review, never a decision. You are responsible for
              verifying AI-assisted observations before relying on them, and
              for all decisions made on your project. Final judgment rests with
              you and your qualified professionals.
            </p>
          </LegalSection>

          <LegalSection n={7} title="Limitation of liability">
            <p>
              The service is provided &ldquo;as is&rdquo; and &ldquo;as
              available&rdquo;. We work to keep it running and accurate, but we
              don&apos;t promise uninterrupted availability, and we don&apos;t
              warrant that every record, verification state or AI output is
              error-free.
            </p>
            <p>
              To the maximum extent permitted by Kenyan law, MjengoOS&apos;s
              total liability arising from your use of the service is limited
              to the fees you paid us in the twelve months before the claim
              (currently zero during the free pilot). We are not liable for
              indirect or consequential losses — including construction
              outcomes, cost overruns, delays, lost profits or disputes between
              project parties. Nothing in these terms limits liability that
              cannot be limited by law.
            </p>
            <p>
              Site safety is never MjengoOS&apos;s responsibility. It rests
              with the qualified persons managing and working on the site, as
              required by law.
            </p>
          </LegalSection>

          <LegalSection n={8} title="Changes to these terms">
            <p>
              We may update these terms as the service changes. Material
              changes will be announced to affected users before they take
              effect, and the &ldquo;last updated&rdquo; date above will always
              reflect the current version. If you continue using the service
              after changes take effect, you accept the updated terms. If you
              don&apos;t, export your data and stop using the service.
            </p>
          </LegalSection>

          <LegalSection n={9} title="Governing law">
            <p>
              These terms are governed by the laws of the Republic of Kenya.
              Any dispute arising from them or from your use of the service
              will be resolved in the courts of Kenya.
            </p>
          </LegalSection>

          <LegalSection n={10} title="Contact">
            <p>
              Questions about these terms:{" "}
              <SiteLink
                href="/contact"
                className="font-medium text-forest-800 underline decoration-forest-800/30 underline-offset-4 hover:decoration-forest-800"
              >
                contact us
              </SiteLink>{" "}
              or{" "}
              <a
                href={`mailto:${SITE.contactEmail}`}
                className="font-medium text-forest-800 underline decoration-forest-800/30 underline-offset-4 hover:decoration-forest-800"
              >
                {SITE.contactEmail}
              </a>
              .
            </p>
          </LegalSection>
        </Reveal>
      </Container>
    </>
  );
}

/* ── Local prose helpers ────────────────────────────────────────────────── */

function LegalSection({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <section className="mt-12 first:mt-8">
      <h2 className="font-display text-xl font-semibold tracking-tight text-ink sm:text-2xl">
        <span className="mr-2 text-earth-600">{n}.</span>
        {title}
      </h2>
      <div className="mt-4 space-y-4 text-[15px] leading-relaxed text-ink-soft">{children}</div>
    </section>
  );
}

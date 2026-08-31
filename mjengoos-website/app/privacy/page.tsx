import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Container } from "@/components/container";
import { Reveal } from "@/components/reveal";
import { SiteLink } from "@/components/site-link";
import { SITE } from "@/lib/site";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description:
    "How MjengoOS collects, uses and protects information — including what we don't do with your data. Read the full privacy policy.",
  alternates: { canonical: "/privacy" },
};

const LAST_UPDATED = "31 August 2026";

export default function PrivacyPage() {
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
              Privacy Policy
            </h1>
            <p className="mt-4 max-w-2xl text-[15px] leading-relaxed text-ink-mute">
              Plain language, on purpose. What we collect, what we do with it,
              and the things we refuse to do.
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
            This policy covers the MjengoOS website and the MjengoOS
            application (together, &ldquo;MjengoOS&rdquo; or &ldquo;the
            service&rdquo;), operated from Kenya. It explains what information
            we handle, why, and the choices you have. If anything here is
            unclear, ask — we answer questions about it.
          </p>

          <LegalSection n={1} title="What we collect">
            <p>We handle four kinds of information:</p>
            <ul className="list-disc space-y-2 pl-5">
              <li>
                <strong>Account information</strong> — your name, email address
                and a password hash when you create an account. Passwords are
                stored hashed, never in plain text.
              </li>
              <li>
                <strong>Project data</strong> — everything you and your team put
                into a project: milestones, variations, budget and payment
                records, attendance, tasks and comments. This is your record;
                we hold it to run the service.
              </li>
              <li>
                <strong>Evidence you capture</strong> — photos, videos and voice
                notes recorded on site, with the capture time and location
                metadata that makes them useful as evidence.
              </li>
              <li>
                <strong>Contact submissions</strong> — the details you send
                through our contact and early-access forms (name, email, role,
                project details, message), which we keep in order to reply.
              </li>
            </ul>
            <p>
              Like nearly all web services, our servers also keep short-lived
              technical logs (including IP addresses used for rate limiting and
              abuse prevention), and our analytics — when enabled — records
              events, not people: no analytics cookies, no cross-site tracking,
              no personally identifiable identifiers in analytics payloads.
            </p>
          </LegalSection>

          <LegalSection n={2} title="How we use it">
            <p>We use the information above to do two things:</p>
            <ul className="list-disc space-y-2 pl-5">
              <li>
                <strong>Provide the service</strong> — store your project
                record, sync it across your team&apos;s devices, run the AI
                analysis you request on photos and voice notes, and generate the
                reports and exports you ask for.
              </li>
              <li>
                <strong>Communicate with you</strong> — reply to your messages,
                run early-access onboarding, and send service notices that
                affect your account or projects.
              </li>
            </ul>
            <p>
              That&apos;s the list. There is no third use hiding behind
              &ldquo;improving your experience&rdquo;.
            </p>
          </LegalSection>

          <LegalSection n={3} title="What we don't do">
            <p>
              Some things we simply refuse to do, stated as a promise rather
              than a footnote:
            </p>
            <ul className="list-disc space-y-2 pl-5">
              <li>We don&apos;t sell your data. To anyone. For any price.</li>
              <li>
                We don&apos;t run advertising trackers or third-party marketing
                pixels on MjengoOS.
              </li>
              <li>
                We don&apos;t share your project data with other projects,
                suppliers or third parties — project scoping keeps records
                isolated, and no one outside a project can see into it.
              </li>
            </ul>
          </LegalSection>

          <LegalSection n={4} title="Data retention & your rights">
            <p>
              Your project data lives with the service while your project is
              active. You don&apos;t have to ask to get it: export is built into
              the platform — reports, ledger, evidence metadata and the audit
              trail in open formats.
            </p>
            <p>
              You can request deletion of your account and personal data at any
              time by{" "}
              <ContactLink />. We&apos;ll remove your data, except where Kenyan
              law requires us to keep specific records — and we&apos;ll tell you
              exactly what was kept and why. If you are part of a shared project
              record, we may retain project evidence that isn&apos;t yours to
              delete alone; we&apos;ll explain what that means for your request
              when you make it.
            </p>
          </LegalSection>

          <LegalSection n={5} title="Security posture">
            <p>
              We treat security as an engineering practice: role-based access
              control enforced server-side, project-level data isolation,
              append-only audit trails, rate limiting and server-side input
              validation. The details are on the{" "}
              <SiteLink
                href="/security"
                className="font-medium text-forest-800 underline decoration-forest-800/30 underline-offset-4 hover:decoration-forest-800"
              >
                security page
              </SiteLink>
              , including what we honestly don&apos;t claim. No compliance
              certifications are held today.
            </p>
          </LegalSection>

          <LegalSection n={6} title="Updates to this policy">
            <p>
              If this policy changes, the &ldquo;last updated&rdquo; date at the
              top changes with it, and material changes will be announced to
              affected users before they take effect. Continuing to use the
              service after an update means you accept the updated policy — and
              you can always export your data and leave if you don&apos;t.
            </p>
          </LegalSection>

          <LegalSection n={7} title="Contact">
            <p>
              Questions about this policy, your data, or a deletion request:{" "}
              <ContactLink /> or{" "}
              <a
                href={`mailto:${SITE.contactEmail}`}
                className="font-medium text-forest-800 underline decoration-forest-800/30 underline-offset-4 hover:decoration-forest-800"
              >
                {SITE.contactEmail}
              </a>
              . We respond within two working days.
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

function ContactLink() {
  return (
    <SiteLink
      href="/contact"
      className="font-medium text-forest-800 underline decoration-forest-800/30 underline-offset-4 hover:decoration-forest-800"
    >
      contact us
    </SiteLink>
  );
}

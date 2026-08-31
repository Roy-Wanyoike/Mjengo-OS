import type { Metadata } from "next";
import {
  KeyRound,
  Boxes,
  UserCog,
  ScrollText,
  Camera,
  FileLock,
  ClipboardCheck,
  Receipt,
  FileDown,
  Gauge,
  ListChecks,
  Lock,
  ArrowRight,
  ShieldCheck,
} from "lucide-react";
import { PageHero, PageSection } from "@/components/page-hero";
import { SectionHeading } from "@/components/section-heading";
import { Container } from "@/components/container";
import { Button } from "@/components/button";
import { Reveal } from "@/components/reveal";
import { SiteLink } from "@/components/site-link";

export const metadata: Metadata = {
  title: "Security",
  description:
    "How MjengoOS handles security as an engineering practice — access control, data integrity, financial controls and operational hardening. What we do, and what we honestly don't claim.",
  alternates: { canonical: "/security" },
};

const ACCESS_CONTROL = [
  {
    icon: KeyRound,
    title: "Role-based access",
    text: "Every account has a role — contractor, client or admin — and the server enforces what that role may do on every request. A client can approve and comment; they cannot rewrite site records. Permissions live server-side, never only in the interface.",
  },
  {
    icon: Boxes,
    title: "Project scoping & isolation",
    text: "Data is scoped to the project it belongs to. Users see records only for projects they're part of — one project's ledger, evidence and documents never leak into another's views or exports.",
  },
  {
    icon: UserCog,
    title: "Least privilege",
    text: "Client surfaces are read-and-decide by design. Share links for stakeholders are read-oriented with a short, explicit allowlist of actions — nothing more. No role gets capabilities its job doesn't need.",
  },
] as const;

const DATA_PRACTICES = [
  {
    icon: ScrollText,
    title: "Append-only audit ledger",
    text: "Significant actions append to an audit ledger — who did what, and when. Nothing edits history: corrections are new entries, so the trail can't quietly change after the fact.",
  },
  {
    icon: Camera,
    title: "Evidence integrity",
    text: "Photos and logs carry capture time and location, and verification states are explicit — verified, review required, pending, not yet. States are recorded as they are, never inferred to look better.",
  },
  {
    icon: FileLock,
    title: "Document handling",
    text: "Land documents, BOQs and invoices are stored per project behind the same access rules as everything else, and export in open formats. Sensitive documents follow the project, not the platform.",
  },
] as const;

const FINANCIAL_CONTROLS = [
  {
    icon: ClipboardCheck,
    title: "Approvals before money moves",
    text: "Milestone releases and variations require an explicit client decision before funds are committed. The approval — who, when, with what note — is part of the permanent record.",
  },
  {
    icon: Receipt,
    title: "M-Pesa reference recording",
    text: "Every payment entry carries its M-Pesa reference code, amount, timestamp and actor. References make statements reconcilable and disputes checkable.",
  },
  {
    icon: FileDown,
    title: "Reconciliation exports",
    text: "The project ledger exports so finance teams can reconcile it against bank and M-Pesa statements independently — the record is verifiable, not just visible.",
  },
] as const;

const OPERATIONAL = [
  {
    icon: Gauge,
    title: "Rate limiting",
    text: "Public endpoints are rate-limited per client to blunt brute-force and abuse traffic — simple, boring, effective.",
  },
  {
    icon: ListChecks,
    title: "Server-side input validation",
    text: "Every submission — forms, API actions, uploads — is validated on the server. The interface mirrors the rules for users; the server is the authority.",
  },
  {
    icon: Lock,
    title: "Session management",
    text: "Signed, expiring sessions with server-side guards on every authenticated route. Sign-out ends the session; stale credentials don't linger.",
  },
] as const;

export default function SecurityPage() {
  return (
    <>
      <PageHero
        eyebrow="Security"
        title="Security as an engineering practice."
        description={
          <>
            No badges we haven&apos;t earned and no bullet-point theatre. This
            page describes what MjengoOS actually does today — and what it
            doesn&apos;t claim.
          </>
        }
      />

      {/* ── Access control ─────────────────────────────────────────────── */}
      <PageSection tone="paper" ariaLabel="Access control">
        <SectionHeading
          eyebrow="Access control"
          title="Who can see and do what."
          description="Permissions are enforced at the server, on every request — the interface is just a window onto those rules."
        />
        <CardGrid cards={ACCESS_CONTROL} />
      </PageSection>

      {/* ── Data ───────────────────────────────────────────────────────── */}
      <PageSection tone="warm" ariaLabel="How we treat data">
        <SectionHeading
          eyebrow="Data"
          title="Records that hold up."
          description="The value of a record is that it can't be quietly rewritten. That's a security property as much as a product one."
        />
        <CardGrid cards={DATA_PRACTICES} />
      </PageSection>

      {/* ── Financial controls ─────────────────────────────────────────── */}
      <PageSection tone="paper" ariaLabel="Financial controls">
        <SectionHeading
          eyebrow="Financial controls"
          title="Money moves with signatures."
          description="MjengoOS is not a bank — it's the record that makes money traceable. The controls below are how that record stays trustworthy."
        />
        <CardGrid cards={FINANCIAL_CONTROLS} />
      </PageSection>

      {/* ── Operational practices ──────────────────────────────────────── */}
      <PageSection tone="warm" ariaLabel="Operational practices">
        <SectionHeading
          eyebrow="Operations"
          title="Boring, done properly."
          description="The unglamorous practices that stop problems before they start."
        />
        <CardGrid cards={OPERATIONAL} />
      </PageSection>

      {/* ── Honesty band + CTA ─────────────────────────────────────────── */}
      <section aria-labelledby="security-honesty-heading" className="relative overflow-hidden bg-forest-900">
        <div className="absolute inset-0 bg-survey-grid-dark" aria-hidden />
        <Container className="relative py-16 sm:py-20">
          <Reveal className="max-w-2xl">
            <div className="flex items-center gap-2.5 text-earth-400">
              <ShieldCheck className="h-5 w-5" aria-hidden />
              <h2
                id="security-honesty-heading"
                className="font-display text-3xl font-semibold leading-tight tracking-tight text-forest-50 sm:text-4xl"
              >
                What we don&apos;t claim
              </h2>
            </div>
            <p className="mt-5 text-lg leading-relaxed text-forest-300/90">
              MjengoOS holds no compliance certifications today — no ISO 27001,
              no SOC 2, no PCI. When that changes, this page will say so
              plainly, with dates, rather than growing a badge wall overnight.
            </p>
            <p className="mt-4 text-[15px] leading-relaxed text-forest-300/80">
              Found something that looks wrong? We&apos;d rather hear it from
              you than read it later. Report security concerns through{" "}
              <SiteLink
                href="/contact"
                className="font-medium text-earth-400 underline decoration-earth-400/40 underline-offset-4 hover:decoration-earth-400"
              >
                contact
              </SiteLink>{" "}
              — mark your message &ldquo;security&rdquo; and we&apos;ll treat it
              with priority. Please give us a chance to respond before anything
              is published.
            </p>
            <div className="mt-8">
              <Button href="/contact" size="lg">
                Report a security concern
                <ArrowRight className="h-4 w-4" aria-hidden />
              </Button>
            </div>
          </Reveal>
        </Container>
      </section>
    </>
  );
}

/* ── Shared card grid (server component) ───────────────────────────────── */

function CardGrid({
  cards,
}: {
  cards: readonly { icon: typeof KeyRound; title: string; text: string }[];
}) {
  return (
    <ul className="mt-10 grid gap-6 md:grid-cols-3">
      {cards.map((card, i) => (
        <Reveal key={card.title} as="li" delay={i * 70}>
          <div className="h-full rounded-2xl border border-ink/10 bg-white p-6">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-forest-100 bg-forest-50 text-forest-700">
              <card.icon className="h-5 w-5" aria-hidden />
            </div>
            <h3 className="mt-4 font-display text-[17px] font-semibold text-ink">
              {card.title}
            </h3>
            <p className="mt-2 text-[14px] leading-relaxed text-ink-mute">{card.text}</p>
          </div>
        </Reveal>
      ))}
    </ul>
  );
}

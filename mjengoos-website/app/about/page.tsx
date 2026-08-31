import type { Metadata } from "next";
import {
  Check,
  ArrowRight,
  AlertTriangle,
  Scale,
  Archive,
  HardHat,
  Sparkles,
  BadgeCheck,
  Globe,
} from "lucide-react";
import { PageHero, PageSection } from "@/components/page-hero";
import { SectionHeading } from "@/components/section-heading";
import { Container } from "@/components/container";
import { Button } from "@/components/button";
import { Reveal } from "@/components/reveal";
import { MapVisual } from "@/components/map-visual";

export const metadata: Metadata = {
  title: "About",
  description:
    "Why MjengoOS exists: construction in Kenya runs on trust, and trust runs on records. Our principles, what's live today, and where we're going.",
  alternates: { canonical: "/about" },
};

const BLIND_TRUST_PAIRS = [
  {
    problem: "Money leaks",
    problemText:
      "Advances, side agreements and invoices nobody can verify quietly widen budgets.",
    change: "Every shilling recorded — payment, reference, actor, timestamp — in one shared ledger.",
  },
  {
    problem: "Progress is an opinion",
    problemText: "\u201c80% done\u201d stays a claim until there\u2019s a dated photo of the walling.",
    change:
      "Daily photo evidence with location and time turns claims into facts.",
  },
  {
    problem: "Disputes without records",
    problemText: "When things go wrong, memory argues with memory — and the project pays.",
    change:
      "An append-only audit trail shows what happened, when, and who decided it.",
  },
  {
    problem: "One point of failure",
    problemText:
      "Trust concentrates in one person; when they\u2019re wrong, absent or gone, the project stalls.",
    change:
      "Clients, funders and site teams all read the same record, from anywhere.",
  },
] as const;

const PRINCIPLES = [
  {
    icon: Scale,
    title: "Evidence over opinion",
    text: "A photo, a timestamp, a ledger entry. When a claim and a record disagree, the record wins.",
  },
  {
    icon: Archive,
    title: "The record belongs to the project",
    text: "Your data is not our asset. Export is built into the platform, and leaving takes your record with you.",
  },
  {
    icon: HardHat,
    title: "Built for the site, not the office",
    text: "Offline-first, low-bandwidth, one device per supervisor. The site is the design centre, not an edge case.",
  },
  {
    icon: Sparkles,
    title: "AI amplifies, people decide",
    text: "AI reads photos and voice notes to draft observations and flag anomalies. Humans verify, approve and decide — always.",
  },
  {
    icon: BadgeCheck,
    title: "Honest states, never inflated claims",
    text: "Verified means checked. Pending means not yet. We never show a green tick where there isn\u2019t one.",
  },
  {
    icon: Globe,
    title: "Kenya first, Africa next, global eventually",
    text: "Built in Nairobi for Kenyan sites, registries and payment rails — then the region, then the world.",
  },
] as const;

const LIVE_TODAY = [
  "Projects, milestones & variations",
  "Photo & video evidence capture",
  "Attendance with PIN muster",
  "Invoices, payments & M-Pesa references",
  "Land records & verification states",
  "Approvals & notifications",
  "AI photo & voice analysis",
  "Offline capture & sync",
] as const;

export default function AboutPage() {
  return (
    <>
      <PageHero
        eyebrow="About"
        title="The operating system for real-world construction."
        description={
          <>
            MjengoOS is being built in Kenya for the way construction actually
            happens here — on site, in cash, often offline, with trust at the
            centre of every decision.
          </>
        }
      />

      {/* ── Why we're building this ───────────────────────────────────── */}
      <PageSection tone="paper" ariaLabel="Why we are building this">
        <SectionHeading
          eyebrow="Why MjengoOS"
          title="Construction runs on trust. Trust runs on records."
        />
        <div className="mt-10 grid gap-10 lg:grid-cols-2 lg:gap-12">
          <Reveal className="space-y-5 text-[15.5px] leading-relaxed text-ink-soft">
            <p>
              Anyone who has built in Kenya knows the pattern. A project starts
              with a handshake and a budget. Money moves in advances and
              installments. Progress arrives as reports — verbal, optimistic, and
              impossible to check from Nairobi, let alone from Boston or London.
            </p>
            <p>
              When the reports and the money disagree, there is nowhere to look.
              No shared ledger. No dated photos. No record of who approved what.
              The dispute becomes memory against memory — and the project, not
              the people, pays for it.
            </p>
            <p>
              MjengoOS exists to change what trust is made of. Not trust in a
              person — trust in a record: every payment with its reference, every
              stage of work with its photos, every decision with a name and a
              timestamp, held where everyone can see it.
            </p>
            <p>
              We&apos;re building it here, for the way construction actually
              happens here — cash-heavy, site-first, frequently offline — because
              software designed for offices doesn&apos;t survive a real site.
            </p>
          </Reveal>

          <Reveal delay={120}>
            <div className="rounded-2xl border border-ink/10 bg-white">
              <div className="border-b border-ink/10 px-6 py-5">
                <h3 className="font-display text-lg font-semibold text-ink">
                  The blind-trust problem — and what changes
                </h3>
              </div>
              <ul className="divide-y divide-ink/10">
                {BLIND_TRUST_PAIRS.map((pair) => (
                  <li key={pair.problem} className="px-6 py-5">
                    <div className="flex items-start gap-3">
                      <AlertTriangle
                        className="mt-0.5 h-4 w-4 shrink-0 text-caution"
                        aria-hidden
                      />
                      <p className="text-[14.5px] leading-relaxed text-ink-mute">
                        <span className="font-semibold text-ink">{pair.problem}.</span>{" "}
                        {pair.problemText}
                      </p>
                    </div>
                    <div className="mt-2.5 flex items-start gap-3 pl-1">
                      <ArrowRight
                        className="mt-0.5 h-4 w-4 shrink-0 text-earth-600"
                        aria-hidden
                      />
                      <p className="text-[14.5px] leading-relaxed text-ink-soft">
                        {pair.change}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          </Reveal>
        </div>
      </PageSection>

      {/* ── Principles ─────────────────────────────────────────────────── */}
      <PageSection tone="warm" ariaLabel="Our principles">
        <SectionHeading
          eyebrow="Principles"
          title="How we decide what to build."
          description="Six rules that outlast any roadmap."
        />
        <ul className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {PRINCIPLES.map((principle, i) => (
            <Reveal key={principle.title} as="li" delay={i * 60}>
              <div className="h-full rounded-2xl border border-ink/10 bg-white p-6">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-forest-100 bg-forest-50 text-forest-700">
                  <principle.icon className="h-5 w-5" aria-hidden />
                </div>
                <h3 className="mt-4 font-display text-[17px] font-semibold text-ink">
                  {principle.title}
                </h3>
                <p className="mt-2 text-[14px] leading-relaxed text-ink-mute">
                  {principle.text}
                </p>
              </div>
            </Reveal>
          ))}
        </ul>
      </PageSection>

      {/* ── Where we are ───────────────────────────────────────────────── */}
      <PageSection tone="paper" ariaLabel="Where we are today">
        <div className="grid gap-10 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-12">
          <Reveal>
            <SectionHeading
              eyebrow="Where we are"
              title="Early access, honestly."
            />
            <div className="mt-5 space-y-4 text-[15.5px] leading-relaxed text-ink-soft">
              <p>
                MjengoOS is a real, working product — not a landing page waiting
                for an engineering team. We are in the early-access stage, with
                the first projects being onboarded in Nairobi and Kiambu while
                the pilot runs free.
              </p>
              <p>
                We don&apos;t publish usage numbers because there aren&apos;t
                usage numbers worth publishing yet. When there are, they&apos;ll
                be real ones.
              </p>
            </div>
          </Reveal>
          <Reveal delay={120}>
            <div className="rounded-2xl border border-ink/10 bg-white p-6 sm:p-7">
              <h3 className="font-display text-lg font-semibold text-ink">
                Live in the product today
              </h3>
              <ul className="mt-5 grid gap-3 sm:grid-cols-2">
                {LIVE_TODAY.map((item) => (
                  <li key={item} className="flex items-start gap-2.5">
                    <Check className="mt-0.5 h-4 w-4 shrink-0 text-verified" aria-hidden />
                    <span className="text-[14.5px] text-ink-soft">{item}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-6 border-t border-ink/10 pt-5 text-[13px] leading-relaxed text-ink-mute">
                Marketplace ordering, portfolio surfaces for funders and the
                public API are in active build. We&apos;ll say they&apos;re live
                when they&apos;re live — not before.
              </p>
            </div>
          </Reveal>
        </div>
      </PageSection>

      {/* ── CTA band ───────────────────────────────────────────────────── */}
      <section aria-labelledby="about-cta-heading" className="relative overflow-hidden bg-forest-900">
        <div className="absolute inset-0 bg-survey-grid-dark" aria-hidden />
        <div className="absolute inset-0 opacity-50" aria-hidden>
          <MapVisual dark className="h-full w-full" />
        </div>
        <Container className="relative py-16 sm:py-20">
          <Reveal className="max-w-2xl">
            <h2
              id="about-cta-heading"
              className="font-display text-3xl font-semibold leading-tight tracking-tight text-forest-50 sm:text-4xl"
            >
              See it for yourself.
            </h2>
            <p className="mt-4 text-lg leading-relaxed text-forest-300/90">
              The fastest way to understand MjengoOS is to put a project on it.
              Early access is free, and we&apos;re honest about fit.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Button href="/signup" size="lg">
                Request early access
                <ArrowRight className="h-4 w-4" aria-hidden />
              </Button>
              <Button href="/contact" size="lg" variant="outline-dark">
                Talk to us first
              </Button>
            </div>
          </Reveal>
        </Container>
      </section>
    </>
  );
}

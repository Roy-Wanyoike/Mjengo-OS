import type { Metadata } from "next";
import {
  LayoutDashboard,
  MapPin,
  Wallet,
  Sparkles,
  Users,
  Package,
  ChevronDown,
  ArrowRight,
  BookOpen,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { PageHero, PageSection } from "@/components/page-hero";
import { SectionHeading } from "@/components/section-heading";
import { Container } from "@/components/container";
import { Button } from "@/components/button";
import { Reveal } from "@/components/reveal";
import { SiteLink } from "@/components/site-link";
import { MapVisual } from "@/components/map-visual";

export const metadata: Metadata = {
  title: "Resources",
  description:
    "Product tours, straight answers and honest documentation status for MjengoOS — learn how evidence-first construction management actually works.",
  alternates: { canonical: "/resources" },
};

const TOURS: { icon: LucideIcon; title: string; description: string; href: string }[] = [
  {
    icon: LayoutDashboard,
    title: "Platform tour",
    description: "Every module on one record — projects, evidence, money, people and materials.",
    href: "/platform",
  },
  {
    icon: MapPin,
    title: "Land verification walkthrough",
    description: "How a plot becomes a property passport with honest verification states.",
    href: "/land-verification",
  },
  {
    icon: Wallet,
    title: "Wallet & approvals",
    description: "Commitments, approvals, M-Pesa references and reconciliation — a ledger, not a bank.",
    href: "/wallet",
  },
  {
    icon: Sparkles,
    title: "AI capabilities",
    description: "What the AI reads, what it flags, and where humans stay in charge.",
    href: "/ai",
  },
  {
    icon: Users,
    title: "Role surfaces",
    description: "What the site supervisor, client, funder and supplier each see — and why.",
    href: "/solutions",
  },
  {
    icon: Package,
    title: "Marketplace",
    description: "Comparing supplier quotes with fair-price context from real projects.",
    href: "/marketplace",
  },
];

const PRODUCT_FAQS = [
  {
    question: "Do workers need smartphones?",
    answer:
      "No. Workers never need a device or an account. Attendance runs on the supervisor's phone with a PIN muster, and workers are paid per the project's own records. Only supervisory and office roles get accounts.",
  },
  {
    question: "Does it work offline?",
    answer:
      "Yes — offline is the design centre, not a fallback. Attendance, photos, deliveries and daily reports capture on the device and sync automatically when any connection returns. Nothing is lost waiting for network.",
  },
  {
    question: "Can I export my data?",
    answer:
      "Yes. Your project's full record — photos, ledger, reports and audit trail — exports in open formats. Export is built into the platform, not held behind a plan.",
  },
  {
    question: "Who owns the data?",
    answer:
      "The project does. MjengoOS stores and processes your record to run the service, but the data belongs to you and your project. You can export it any time, or request deletion through contact.",
  },
  {
    question: "What does M-Pesa integration mean?",
    answer:
      "It means MjengoOS records M-Pesa payments — the reference code, amount, timestamp and actor go into the project ledger. It does not move money and holds no deposits. Money moves through your own M-Pesa and bank accounts, as always.",
  },
];

export default function ResourcesPage() {
  return (
    <>
      <PageHero
        eyebrow="Resources"
        title="Learn the MjengoOS way."
        description={
          <>
            Short tours of the real product, and straight answers to the
            questions people actually ask — starting with the ones most
            software companies avoid.
          </>
        }
      />

      {/* ── Product tours ──────────────────────────────────────────────── */}
      <PageSection tone="warm" ariaLabel="Product tours">
        <SectionHeading
          eyebrow="Tours"
          title="Walk the product, page by page."
          description="Each tour walks one part of the platform with real screens and honest labels — no stock dashboards."
        />
        <ul className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {TOURS.map((tour, i) => (
            <Reveal key={tour.href} as="li" delay={i * 60}>
              <SiteLink
                href={tour.href}
                className="group flex h-full flex-col rounded-2xl border border-ink/10 bg-white p-6 transition-all duration-200 hover:border-forest-600/40 hover:shadow-[0_12px_32px_-16px_rgb(18_60_50/0.28)]"
              >
                <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-forest-100 bg-forest-50 text-forest-700">
                  <tour.icon className="h-5 w-5" aria-hidden />
                </div>
                <h3 className="mt-4 font-display text-[17px] font-semibold text-ink transition-colors group-hover:text-forest-800">
                  {tour.title}
                </h3>
                <p className="mt-1.5 text-[14px] leading-relaxed text-ink-mute">
                  {tour.description}
                </p>
                <span className="mt-auto inline-flex items-center gap-1.5 pt-5 text-[13.5px] font-medium text-forest-700">
                  Take the tour
                  <ArrowRight
                    className="h-3.5 w-3.5 transition-transform duration-200 group-hover:translate-x-0.5"
                    aria-hidden
                  />
                </span>
              </SiteLink>
            </Reveal>
          ))}
        </ul>
      </PageSection>

      {/* ── Product FAQ ────────────────────────────────────────────────── */}
      <PageSection tone="paper" id="faq" ariaLabel="Frequently asked questions">
        <SectionHeading
          eyebrow="FAQ"
          title="Questions people actually ask."
          description="About using the product — phones, networks, data and money. Pricing questions live on the pricing page."
        />
        <Reveal className="mt-10 max-w-3xl space-y-3" delay={80}>
          {PRODUCT_FAQS.map((faq) => (
            <details
              key={faq.question}
              className="group rounded-xl border border-ink/10 bg-white"
            >
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-5 py-4 text-left transition-colors hover:bg-paper/70 [&::-webkit-details-marker]:hidden">
                <span className="text-[15px] font-semibold text-ink">{faq.question}</span>
                <ChevronDown
                  className="h-4 w-4 shrink-0 text-ink-mute transition-transform duration-300 group-open:rotate-180"
                  aria-hidden
                />
              </summary>
              <p className="px-5 pb-5 text-[14.5px] leading-relaxed text-ink-soft">
                {faq.answer}
              </p>
            </details>
          ))}
        </Reveal>
      </PageSection>

      {/* ── Documentation status — honest block ────────────────────────── */}
      <PageSection tone="warm" ariaLabel="Documentation status">
        <Reveal>
          <div className="mx-auto flex max-w-3xl flex-col items-start gap-5 rounded-2xl border border-ink/10 bg-white p-7 sm:flex-row sm:gap-7 sm:p-8">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-forest-100 bg-forest-50 text-forest-700">
              <BookOpen className="h-6 w-6" aria-hidden />
            </div>
            <div>
              <h2 className="font-display text-xl font-semibold text-ink">
                Documentation is in progress
              </h2>
              <p className="mt-3 text-[15px] leading-relaxed text-ink-soft">
                Full product documentation ships with public launch. Until then,
                the tours above cover every part of the platform — and a direct
                line to the team covers everything else. If something is
                unclear, ask, and you&apos;ll get a real answer rather than a
                support script.
              </p>
              <div className="mt-5">
                <Button href="/contact" variant="secondary" size="sm">
                  Ask us anything
                  <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                </Button>
              </div>
            </div>
          </div>
        </Reveal>
      </PageSection>

      {/* ── CTA band ───────────────────────────────────────────────────── */}
      <section aria-labelledby="resources-cta-heading" className="relative overflow-hidden bg-forest-900">
        <div className="absolute inset-0 bg-survey-grid-dark" aria-hidden />
        <div className="absolute inset-0 opacity-50" aria-hidden>
          <MapVisual dark className="h-full w-full" />
        </div>
        <Container className="relative py-16 sm:py-20">
          <Reveal className="max-w-2xl">
            <h2
              id="resources-cta-heading"
              className="font-display text-3xl font-semibold leading-tight tracking-tight text-forest-50 sm:text-4xl"
            >
              Reading is good. Building is better.
            </h2>
            <p className="mt-4 text-lg leading-relaxed text-forest-300/90">
              Put a real project on MjengoOS during the pilot and learn the
              system the way it deserves — by using it.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Button href="/signup" size="lg">
                Request early access
                <ArrowRight className="h-4 w-4" aria-hidden />
              </Button>
              <Button href="/contact" size="lg" variant="outline-dark">
                Talk to us
              </Button>
            </div>
          </Reveal>
        </Container>
      </section>
    </>
  );
}

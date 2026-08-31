import type { Metadata } from "next";
import { Check, ArrowRight } from "lucide-react";
import { PageHero, PageSection } from "@/components/page-hero";
import { Container } from "@/components/container";
import { Button } from "@/components/button";
import { Reveal } from "@/components/reveal";
import { Badge } from "@/components/badge";
import { SiteLink } from "@/components/site-link";
import { ContactForm } from "@/components/contact-form";

export const metadata: Metadata = {
  title: "Get Started",
  description:
    "Request early access to MjengoOS. Free during the pilot — the full platform, up to 3 projects, and a direct line to the product team. Nairobi & Kiambu first.",
  alternates: { canonical: "/signup" },
};

const WHAT_YOU_GET = [
  "The full platform — every module, no gates",
  "Up to 3 active projects",
  "A direct line to the people building the product",
  "Your feedback shaping the roadmap",
] as const;

const PERFECT_FOR = [
  "Building now",
  "Planning a build",
  "Funding projects",
  "Professional practice",
] as const;

export default function SignupPage() {
  return (
    <>
      <PageHero
        dark
        eyebrow="Get started"
        title="Start building with evidence."
        description={
          <>
            Early-access onboarding runs in batches, with Nairobi &amp; Kiambu
            projects first. Every pilot project gets the full platform — free
            for the life of those projects.
          </>
        }
      />

      <PageSection tone="paper" ariaLabel="Request early access">
        <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_360px] lg:gap-12">
          {/* Form */}
          <Reveal>
            <div className="rounded-2xl border border-ink/10 bg-white p-6 sm:p-8">
              <h2 className="font-display text-xl font-semibold text-ink">Request access</h2>
              <p className="mt-1.5 text-[14px] text-ink-mute">
                Tell us who you are and what you&apos;re building — we onboard in
                small batches so every project gets a real setup call.
              </p>
              <div className="mt-7">
                <ContactForm
                  config={{
                    source: "signup",
                    submitLabel: "Request access",
                    successTitle: "You're on the list.",
                    successText:
                      "We onboarding projects in batches — you'll hear from us within two working days.",
                    analyticsEvent: "signup_completed",
                  }}
                />
              </div>
            </div>
          </Reveal>

          {/* Side panel */}
          <Reveal delay={120}>
            <div className="space-y-6">
              <div className="rounded-2xl border border-ink/10 bg-white p-6">
                <h2 className="font-display text-lg font-semibold text-ink">What you get</h2>
                <ul className="mt-5 space-y-3">
                  {WHAT_YOU_GET.map((item) => (
                    <li key={item} className="flex items-start gap-2.5">
                      <Check className="mt-0.5 h-4 w-4 shrink-0 text-verified" aria-hidden />
                      <span className="text-[14.5px] text-ink-soft">{item}</span>
                    </li>
                  ))}
                </ul>
                <p className="mt-6 border-t border-ink/10 pt-5 text-[13px] leading-relaxed text-ink-mute">
                  No credit card, no mailing list. The pilot is free — and pilot
                  projects keep their terms when published pricing arrives.
                </p>
              </div>

              <div className="rounded-2xl border border-ink/10 bg-paper-warm/60 p-6">
                <h3 className="text-[14.5px] font-semibold text-ink">Perfect for</h3>
                <ul className="mt-3.5 flex flex-wrap gap-2" aria-label="Who early access is perfect for">
                  {PERFECT_FOR.map((chip) => (
                    <li key={chip}>
                      <Badge tone="forest">{chip}</Badge>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="rounded-2xl border border-ink/10 bg-white p-6">
                <h3 className="text-[14.5px] font-semibold text-ink">
                  Building outside Nairobi &amp; Kiambu?
                </h3>
                <p className="mt-2 text-[13.5px] leading-relaxed text-ink-mute">
                  Join the list anyway. We expand by batch, not by announcement
                  — and we&apos;ll tell you honestly where your project stands.
                  Questions in the meantime?{" "}
                  <SiteLink
                    href="/contact"
                    className="font-medium text-forest-800 underline decoration-forest-800/30 underline-offset-4 hover:decoration-forest-800"
                  >
                    Contact us
                  </SiteLink>
                  .
                </p>
              </div>
            </div>
          </Reveal>
        </div>
      </PageSection>

      {/* ── Bottom reassurance band ────────────────────────────────────── */}
      <section aria-labelledby="signup-cta-heading" className="relative overflow-hidden bg-forest-900">
        <div className="absolute inset-0 bg-survey-grid-dark" aria-hidden />
        <Container className="relative py-14 sm:py-16">
          <Reveal className="flex flex-col items-start justify-between gap-6 sm:flex-row sm:items-center">
            <div>
              <h2
                id="signup-cta-heading"
                className="font-display text-2xl font-semibold tracking-tight text-forest-50 sm:text-3xl"
              >
                Want to see it before you commit?
              </h2>
              <p className="mt-2 text-[15px] leading-relaxed text-forest-300/90">
                We&apos;ll walk your project through the platform with you —
                no slides, the real product.
              </p>
            </div>
            <Button href="/contact" size="lg" variant="outline-dark">
              Book a walkthrough
              <ArrowRight className="h-4 w-4" aria-hidden />
            </Button>
          </Reveal>
        </Container>
      </section>
    </>
  );
}

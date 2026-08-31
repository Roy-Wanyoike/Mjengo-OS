import type { Metadata } from "next";
import { Mail, ArrowRight } from "lucide-react";
import { PageHero, PageSection } from "@/components/page-hero";
import { Container } from "@/components/container";
import { Button } from "@/components/button";
import { Reveal } from "@/components/reveal";
import { Badge } from "@/components/badge";
import { ContactForm } from "@/components/contact-form";
import { SITE } from "@/lib/site";

export const metadata: Metadata = {
  title: "Contact",
  description:
    "Tell the MjengoOS team about your construction project — questions, feedback, partnership and early-access requests. We reply within two working days.",
  alternates: { canonical: "/contact" },
};

const NEXT_STEPS = [
  {
    title: "You send",
    text: "Your message lands in our queue with everything you shared — no forms lost in transit.",
  },
  {
    title: "We read",
    text: "A person reads it within two working days. No auto-responder pretending otherwise.",
  },
  {
    title: "We reply",
    text: "With answers, next steps, or a slot in the next onboarding batch — honestly either way.",
  },
] as const;

const contactJsonLd = {
  "@context": "https://schema.org",
  "@type": "ContactPage",
  name: "Contact MjengoOS",
  description:
    "Contact the MjengoOS team about your construction project — questions, feedback and early-access requests.",
  url: `${SITE.url}/contact`,
};

export default function ContactPage() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(contactJsonLd) }}
      />

      <PageHero
        eyebrow="Contact"
        title="Tell us about your project."
        description={
          <>
            Building, funding, supplying or supervising — questions, feedback and
            early-access requests all land in the same place, and all get a real
            answer.
          </>
        }
      />

      <PageSection tone="paper" ariaLabel="Contact form and details">
        <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_360px] lg:gap-12">
          {/* Form */}
          <Reveal>
            <div className="rounded-2xl border border-ink/10 bg-white p-6 sm:p-8">
              <h2 className="font-display text-xl font-semibold text-ink">Send a message</h2>
              <p className="mt-1.5 text-[14px] text-ink-mute">
                The more you tell us, the more useful our first reply will be.
              </p>
              <div className="mt-7">
                <ContactForm
                  config={{
                    source: "contact",
                    submitLabel: "Send message",
                    successTitle: "Message received.",
                    successText:
                      "We'll get back to you within two working days.",
                    analyticsEvent: "contact_submitted",
                  }}
                />
              </div>
            </div>
          </Reveal>

          {/* Side panel */}
          <Reveal delay={120}>
            <div className="space-y-6">
              <div className="rounded-2xl border border-ink/10 bg-white p-6">
                <h2 className="font-display text-lg font-semibold text-ink">
                  What happens next
                </h2>
                <ol className="mt-5 space-y-5">
                  {NEXT_STEPS.map((step, i) => (
                    <li key={step.title} className="flex items-start gap-3.5">
                      <span
                        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-forest-100 bg-forest-50 font-display text-[12px] font-semibold text-forest-800"
                        aria-hidden
                      >
                        {i + 1}
                      </span>
                      <div>
                        <h3 className="text-[14.5px] font-semibold text-ink">{step.title}</h3>
                        <p className="mt-1 text-[13.5px] leading-relaxed text-ink-mute">
                          {step.text}
                        </p>
                      </div>
                    </li>
                  ))}
                </ol>
              </div>

              <div className="rounded-2xl border border-ink/10 bg-paper-warm/60 p-6">
                <Badge tone="earth" caps>
                  Early access
                </Badge>
                <p className="mt-3 text-[14px] leading-relaxed text-ink-soft">
                  We&apos;re onboarding projects in Nairobi &amp; Kiambu first,
                  free during the pilot. If you&apos;re building elsewhere,
                  write anyway — we&apos;ll tell you honestly where you stand.
                </p>
              </div>

              <div className="rounded-2xl border border-ink/10 bg-white p-6">
                <h3 className="flex items-center gap-2 text-[14.5px] font-semibold text-ink">
                  <Mail className="h-4 w-4 text-forest-700" aria-hidden />
                  Prefer email?
                </h3>
                <a
                  href={`mailto:${SITE.contactEmail}`}
                  className="mt-2 inline-block text-[15px] font-medium text-forest-800 underline decoration-forest-800/30 underline-offset-4 transition-colors hover:decoration-forest-800"
                >
                  {SITE.contactEmail}
                </a>
                <p className="mt-2 text-[13px] leading-relaxed text-ink-mute">
                  Same queue, same two-working-day promise.
                </p>
              </div>
            </div>
          </Reveal>
        </div>
      </PageSection>

      {/* ── CTA band ───────────────────────────────────────────────────── */}
      <section aria-labelledby="contact-cta-heading" className="relative overflow-hidden bg-forest-900">
        <div className="absolute inset-0 bg-survey-grid-dark" aria-hidden />
        <Container className="relative py-14 sm:py-16">
          <Reveal className="flex flex-col items-start justify-between gap-6 sm:flex-row sm:items-center">
            <div>
              <h2
                id="contact-cta-heading"
                className="font-display text-2xl font-semibold tracking-tight text-forest-50 sm:text-3xl"
              >
                Ready to skip the conversation?
              </h2>
              <p className="mt-2 text-[15px] leading-relaxed text-forest-300/90">
                Request early access directly — you can always ask questions
                after.
              </p>
            </div>
            <Button href="/signup" size="lg">
              Request access
              <ArrowRight className="h-4 w-4" aria-hidden />
            </Button>
          </Reveal>
        </Container>
      </section>
    </>
  );
}

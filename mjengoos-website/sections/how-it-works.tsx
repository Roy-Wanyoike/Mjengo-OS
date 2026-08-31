import { Container } from "@/components/container";
import { SectionHeading } from "@/components/section-heading";
import { Reveal } from "@/components/reveal";

/**
 * How it works (§34) — four steps.
 */
const STEPS = [
  {
    n: "01",
    title: "Create your project",
    text: "Set the budget, phases and milestones — the plan becomes the project's operating baseline.",
  },
  {
    n: "02",
    title: "Connect the people",
    text: "Invite your supervisor, verify professionals, bring suppliers and the client into the same record.",
  },
  {
    n: "03",
    title: "Capture what's happening",
    text: "Attendance, photos with GPS, deliveries, voice notes — the site documents itself as it works.",
  },
  {
    n: "04",
    title: "Track everything from one place",
    text: "Progress, money and decisions — grounded in evidence, ready for review any day.",
  },
] as const;

export function HowItWorks() {
  return (
    <section aria-labelledby="how-heading" className="border-b border-ink/10 bg-paper">
      <Container className="py-20 lg:py-28">
        <SectionHeading
          eyebrow="How it works"
          title={<span id="how-heading">From groundbreaking to handover, in four moves.</span>}
          align="center"
        />

        <ol className="mt-14 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map((step, i) => (
            <Reveal as="li" key={step.n} delay={i * 90}>
              <div className="relative h-full rounded-xl border border-ink/10 bg-white p-6">
                <span className="font-display text-[40px] font-bold leading-none text-earth-300">
                  {step.n}
                </span>
                <h3 className="mt-4 font-display text-[17px] font-semibold text-ink">{step.title}</h3>
                <p className="mt-2 text-[14px] leading-relaxed text-ink-mute">{step.text}</p>
                {i < STEPS.length - 1 && (
                  <span aria-hidden className="absolute -right-3.5 top-1/2 hidden -translate-y-1/2 text-ink-faint lg:block">
                    <svg viewBox="0 0 12 12" className="h-6 w-6">
                      <path d="M2 6h6M5.5 2.5 9 6l-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </span>
                )}
              </div>
            </Reveal>
          ))}
        </ol>
      </Container>
    </section>
  );
}

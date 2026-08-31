import { Camera, UserRoundCheck, Smartphone, Database } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { PageSection } from "@/components/page-hero";
import { SectionHeading } from "@/components/section-heading";
import { Reveal } from "@/components/reveal";
import { Badge } from "@/components/badge";

/**
 * /wallet — the release workflow: Evidence attached → Client approval →
 * Payment recorded (M-Pesa reference + actor) → Ledger entry. Four steps
 * with icons (§25).
 */
const STEPS: { icon: LucideIcon; title: string; text: string }[] = [
  {
    icon: Camera,
    title: "Evidence attached",
    text: "Photos, sign-offs and delivery records are attached to the milestone before anything else can happen.",
  },
  {
    icon: UserRoundCheck,
    title: "Client approval",
    text: "The client reviews the evidence and approves — from Nairobi or from another continent, on their own device.",
  },
  {
    icon: Smartphone,
    title: "Payment recorded",
    text: "The payment is made by a person, and recorded with its M-Pesa reference — plus who made it and when.",
  },
  {
    icon: Database,
    title: "Ledger entry",
    text: "The wallet writes the entry: amount, actor, timestamp, note. Committed becomes spent, on the record.",
  },
];

export function ReleaseWorkflow() {
  return (
    <PageSection tone="warm" ariaLabel="The release workflow">
      <SectionHeading
        eyebrow="The release workflow"
        title="Money moves after evidence, not before."
        description="Four steps, in this order, every time. The sequence is the product — approvals that arrive before evidence are exactly what the queue exists to prevent."
      />

      <ol className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4" aria-label="Release workflow, four steps">
        {STEPS.map((step, i) => (
          <Reveal as="li" key={step.title} delay={i * 70}>
            <div className="h-full rounded-xl border border-ink/10 bg-white p-5">
              <div className="flex items-center justify-between">
                <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-forest-50 text-forest-700 ring-1 ring-forest-100">
                  <step.icon className="h-4.5 w-4.5" aria-hidden />
                </span>
                <span className="font-mono text-[10px] font-bold tracking-[0.18em] text-earth-600">
                  {String(i + 1).padStart(2, "0")}
                </span>
              </div>
              <h3 className="mt-3 font-display text-[16px] font-semibold leading-tight text-ink">{step.title}</h3>
              <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-mute">{step.text}</p>
            </div>
          </Reveal>
        ))}
      </ol>

      <Reveal delay={300} className="mt-8">
        <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-ink/10 bg-white px-5 py-4">
          <p className="max-w-2xl text-[14px] leading-relaxed text-ink-soft">
            Every release leaves a line a human can read: who approved it, who paid it, which M-Pesa
            reference carried it, and what evidence justified it.
          </p>
          <Badge tone="earth">
            <span className="font-mono text-[10px] tracking-wider">EVIDENCE → APPROVAL → PAYMENT → LEDGER</span>
          </Badge>
        </div>
      </Reveal>
    </PageSection>
  );
}

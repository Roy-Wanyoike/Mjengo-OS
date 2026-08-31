import { FileUp, FileSearch, Link2, BadgeCheck } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { PageSection } from "@/components/page-hero";
import { SectionHeading } from "@/components/section-heading";
import { Reveal } from "@/components/reveal";
import { VerificationBadge } from "@/components/badge";

/**
 * /professionals — how verification works: four steps, with the honest
 * language at the centre. "Licence body reference recorded" — NOT
 * "confirmed with the body".
 */
const STEPS: { icon: LucideIcon; title: string; text: string }[] = [
  {
    icon: FileUp,
    title: "Licence details submitted",
    text: "The professional submits their licence or practising-certificate details when joining the network.",
  },
  {
    icon: FileSearch,
    title: "Document review",
    text: "Our team reviews the submitted documents — completeness, consistency, and that they belong to the person submitting them.",
  },
  {
    icon: Link2,
    title: "Licence body reference recorded",
    text: "The reference to the issuing body — LSK, BORAQS, EBK, the Land Surveyors Board, NCA — is recorded on the professional's profile.",
  },
  {
    icon: BadgeCheck,
    title: "Verified badge + assignments",
    text: "The badge appears on the profile, and the professional can be assigned to projects in their trade and county.",
  },
];

export function VerificationSteps() {
  return (
    <PageSection tone="warm" ariaLabel="How professional verification works">
      <SectionHeading
        eyebrow="How verification works"
        title="Checked before they take assignments."
        description="Four steps, plainly stated — because a badge is only worth what it honestly means."
      />

      <ol className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4" aria-label="Professional verification steps">
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

      {/* The honest meaning of the badge */}
      <Reveal delay={320} className="mt-8">
        <div className="flex flex-col items-start gap-5 rounded-xl border border-caution/30 bg-caution-soft px-5 py-5 sm:flex-row sm:items-center">
          <VerificationBadge state="verified" label="Licence checked" className="shrink-0" />
          <p className="text-[14px] leading-relaxed text-ink-soft">
            What the badge means: <strong className="font-semibold">the licence documents were reviewed and the
            issuing body&rsquo;s register reference was recorded</strong>. It does not mean the body confirmed
            the licence with us, and it is not their endorsement. Verification renewals follow the licence&rsquo;s
            own expiry — an expired document is surfaced, not hidden.
          </p>
        </div>
      </Reveal>
    </PageSection>
  );
}

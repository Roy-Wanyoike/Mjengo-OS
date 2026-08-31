import { Lock, Users, ScrollText, Landmark, Receipt, FileLock2 } from "lucide-react";
import { Container } from "@/components/container";
import { SectionHeading } from "@/components/section-heading";
import { Reveal } from "@/components/reveal";
import { Button } from "@/components/button";
import { VerificationBadge } from "@/components/badge";
import type { VerificationState } from "@/types";

/**
 * Trust + security (§32/§33) — verification matrix + security practices.
 * Only claims the product actually implements. No certification claims.
 */
const MATRIX: { area: string; state: VerificationState; note: string }[] = [
  { area: "Property", state: "verified", note: "passport of checks & who did them" },
  { area: "Survey", state: "verified", note: "beacon & boundary records" },
  { area: "Professional", state: "verified", note: "licence on record" },
  { area: "Materials", state: "verified", note: "order → delivery → inspection" },
  { area: "Delivery", state: "verified", note: "photo at the gate" },
  { area: "Payment", state: "verified", note: "method + reference recorded" },
  { area: "Progress", state: "verified", note: "GPS + timestamped photos" },
];

const SECURITY = [
  { icon: Users, title: "Role-based access", text: "Every user has a role; every role sees and can do only what it should — enforced server-side, not just hidden in the UI." },
  { icon: Lock, title: "Project permissions", text: "Users are scoped to their projects. A foreign project simply doesn't exist for them." },
  { icon: FileLock2, title: "Tenant isolation", text: "Project data is separated per project boundary — client views stay pinned to their own build." },
  { icon: ScrollText, title: "Audit logs", text: "An append-only ledger records who did what, when — decisions, approvals, releases, exceptions." },
  { icon: Landmark, title: "Financial controls", text: "Approvals precede money movement; milestone releases require evidence and a human decision." },
  { icon: Receipt, title: "Transaction records", text: "Every payment carries its method and reference — M-Pesa codes on the record, not on trust." },
] as const;

export function TrustMatrix() {
  return (
    <section aria-labelledby="trust-heading" className="border-b border-ink/10 bg-paper">
      <Container className="py-20 lg:py-28">
        <SectionHeading
          eyebrow="Trust & security"
          title={<span id="trust-heading">Know what has been verified.</span>}
          description="Every claim in MjengoOS carries its verification state — and every state is explainable: who checked it, against what, and when."
        />

        <div className="mt-12 grid gap-10 lg:grid-cols-[1fr_1.2fr] lg:gap-16">
          {/* Verification matrix */}
          <Reveal>
            <div className="overflow-hidden rounded-xl border border-ink/10 bg-white shadow-[0_24px_64px_-28px_rgb(23_25_24/0.3)]">
              <div className="border-b border-ink/10 bg-forest-900 px-5 py-4">
                <p className="font-display text-[15px] font-semibold text-forest-50">Verification matrix</p>
                <p className="text-[11.5px] text-forest-300/80">Example project — states differ per project</p>
              </div>
              <ul className="divide-y divide-ink/10">
                {MATRIX.map((row, i) => (
                  <Reveal as="li" key={row.area} delay={i * 50}>
                    <div className="flex items-center justify-between gap-4 px-5 py-3">
                      <div>
                        <p className="text-[14.5px] font-semibold text-ink">{row.area}</p>
                        <p className="text-[11.5px] text-ink-mute">{row.note}</p>
                      </div>
                      <VerificationBadge state={row.state} />
                    </div>
                  </Reveal>
                ))}
              </ul>
              <p className="border-t border-ink/10 bg-paper px-5 py-3 text-[11.5px] leading-relaxed text-ink-mute">
                States are per-project facts: submitted, reviewed, professionally verified, or flagged.
                Nothing upgrades silently.
              </p>
            </div>
          </Reveal>

          {/* Security practices */}
          <div>
            <div className="grid gap-4 sm:grid-cols-2">
              {SECURITY.map((item, i) => (
                <Reveal key={item.title} delay={i * 60}>
                  <article className="h-full rounded-xl border border-ink/10 bg-white p-5">
                    <item.icon className="h-5 w-5 text-forest-700" aria-hidden />
                    <h3 className="mt-3 font-display text-[15.5px] font-semibold text-ink">{item.title}</h3>
                    <p className="mt-1.5 text-[13.5px] leading-relaxed text-ink-mute">{item.text}</p>
                  </article>
                </Reveal>
              ))}
            </div>
            <Reveal delay={200} className="mt-5">
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-ink/10 bg-paper-warm px-5 py-4">
                <p className="max-w-md text-[13px] leading-relaxed text-ink-mute">
                  Security is an engineering practice here, not a badge we buy. No compliance
                  certifications are claimed — when that changes, it will be stated plainly.
                </p>
                <Button href="/security" variant="ghost" size="sm" className="-ml-1">
                  Read the security approach
                </Button>
              </div>
            </Reveal>
          </div>
        </div>
      </Container>
    </section>
  );
}

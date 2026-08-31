import { MapPin, Wallet, Package, TrendingUp, ArrowDown } from "lucide-react";
import { Container } from "@/components/container";
import { SectionHeading } from "@/components/section-heading";
import { Reveal } from "@/components/reveal";

/**
 * The problem (§15): four blind-trust questions, then the turn —
 * "MjengoOS connects the evidence."
 */
const PROBLEMS = [
  {
    icon: MapPin,
    kicker: "Land",
    headline: "Is the property actually what you're being told it is?",
    text: "Titles, beacons, boundaries, encumbrances — the story and the record are not always the same thing.",
  },
  {
    icon: Wallet,
    kicker: "Money",
    headline: "Where did the project money go?",
    text: "Payments leave your account. Weeks later, nobody can reconstruct what they bought.",
  },
  {
    icon: Package,
    kicker: "Materials",
    headline: "Was everything ordered actually delivered?",
    text: "Orders live on WhatsApp. Deliveries arrive unverified. Shortages surface as delays.",
  },
  {
    icon: TrendingUp,
    kicker: "Progress",
    headline: "Is the project really as far along as reported?",
    text: "\u201CWe're 70% done\u201D — until you visit and discover the slab hasn't been cast.",
  },
] as const;

export function Problem() {
  return (
    <section aria-labelledby="problem-heading" className="border-b border-ink/10 bg-paper">
      <Container className="py-20 lg:py-28">
        <SectionHeading
          eyebrow="The problem"
          title={<span id="problem-heading">Construction shouldn't require blind trust.</span>}
          description="Every build runs on the same four questions. Today, the answers are opinions."
        />

        <div className="mt-12 grid gap-5 sm:grid-cols-2">
          {PROBLEMS.map((p, i) => (
            <Reveal key={p.kicker} delay={i * 80}>
              <article className="group h-full rounded-xl border border-ink/10 bg-white p-6 shadow-[0_1px_2px_rgb(23_25_24/0.04)] transition-shadow hover:shadow-[0_4px_24px_-12px_rgb(23_25_24/0.18)] sm:p-7">
                <div className="flex items-center justify-between">
                  <p.icon className="h-5 w-5 text-earth-600" aria-hidden />
                  <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-faint">
                    {p.kicker}
                  </span>
                </div>
                <h3 className="mt-4 font-display text-xl font-semibold leading-snug tracking-tight text-ink">
                  {p.headline}
                </h3>
                <p className="mt-2.5 text-[15px] leading-relaxed text-ink-mute">{p.text}</p>
              </article>
            </Reveal>
          ))}
        </div>

        {/* The turn */}
        <Reveal delay={200} className="mt-14">
          <div className="flex flex-col items-center gap-3 text-center">
            <ArrowDown className="h-5 w-5 text-earth-600" aria-hidden />
            <p className="font-display text-2xl font-semibold tracking-tight text-forest-800 sm:text-3xl">
              MjengoOS connects the evidence.
            </p>
            <p className="max-w-xl text-[15px] leading-relaxed text-ink-mute">
              The land record, the people, the materials, the money and the daily physical proof —
              one connected record instead of four blind spots.
            </p>
          </div>
        </Reveal>
      </Container>
    </section>
  );
}

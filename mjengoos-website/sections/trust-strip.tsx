import { ShieldCheck, Camera, WifiOff, FileSearch } from "lucide-react";
import { Container } from "@/components/container";
import { Reveal } from "@/components/reveal";

/**
 * Trust band (§10 TRUST / SOCIAL PROOF) — honest early-stage positioning:
 * no fake logos, no fake numbers. What MjengoOS stands on, today.
 */
const PILLARS = [
  {
    icon: Camera,
    title: "Physical ground truth",
    text: "Photos with GPS and timestamps — captured by people who are actually on site.",
  },
  {
    icon: ShieldCheck,
    title: "Evidence before money",
    text: "Milestone releases are tied to proof of work, not promises.",
  },
  {
    icon: WifiOff,
    title: "Offline-first",
    text: "Built for sites where connectivity is a luxury, not an assumption.",
  },
  {
    icon: FileSearch,
    title: "A record you can audit",
    text: "Every decision logged — who, what, when. Disputes land on facts.",
  },
] as const;

export function TrustStrip() {
  return (
    <section aria-label="What MjengoOS stands on" className="border-b border-ink/10 bg-forest-950">
      <Container className="py-10 lg:py-12">
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {PILLARS.map((p, i) => (
            <Reveal key={p.title} delay={i * 70} className="flex gap-3.5">
              <p.icon className="mt-0.5 h-5 w-5 shrink-0 text-earth-400" aria-hidden />
              <div>
                <p className="text-sm font-semibold text-forest-50">{p.title}</p>
                <p className="mt-1 text-[13px] leading-relaxed text-forest-300/80">{p.text}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </Container>
    </section>
  );
}

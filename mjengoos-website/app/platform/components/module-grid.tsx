import {
  Landmark,
  DraftingCompass,
  ClipboardList,
  HardHat,
  Truck,
  Wallet,
  Camera,
  Sparkles,
  WifiOff,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";
import { PageSection } from "@/components/page-hero";
import { SectionHeading } from "@/components/section-heading";
import { Reveal } from "@/components/reveal";
import { cn } from "@/lib/utils";

/**
 * /platform — the module grid. Ten modules, each with an icon, a plain-language
 * description and three capability chips. Card pattern borrowed from the
 * ecosystem section, promoted to full cards.
 */
const MODULES: { icon: LucideIcon; name: string; description: string; caps: string[] }[] = [
  {
    icon: Landmark,
    name: "Land verification",
    description:
      "Know the ground before you plan on it. The Property Passport organizes title documents, registry searches, surveys and inspections — and connects you with the verified professionals who do the work.",
    caps: ["Title deed records", "Registry search", "Beacon verification"],
  },
  {
    icon: DraftingCompass,
    name: "Professionals",
    description:
      "Surveyors, architects, engineers and QS — verified and attached to the project. Licences on record, assignments received, reports filed where the work happened.",
    caps: ["Licence verification", "Assignments", "Report filing"],
  },
  {
    icon: ClipboardList,
    name: "Project management & BOQ",
    description:
      "Phases with budgets, milestones with evidence, variations with a decision trail. The operational spine of the build, kept in the same record as everything else.",
    caps: ["Phases & budgets", "Milestones", "Variations"],
  },
  {
    icon: HardHat,
    name: "Workers & attendance",
    description:
      "Muster workers with PIN attendance in seconds — no smartphones needed in anyone's pocket. Wage records build from the attendance itself, so pay day stops being a dispute.",
    caps: ["PIN attendance", "Muster roll", "Wage records"],
  },
  {
    icon: Truck,
    name: "Materials & procurement",
    description:
      "From BOQ line to delivery photo: quote requests to suppliers, price comparison, purchase orders and verified deliveries — the full procurement chain in one ledger.",
    caps: ["Quote requests", "Supplier comparison", "Delivery proof"],
  },
  {
    icon: Wallet,
    name: "Wallet & payments",
    description:
      "One financial record per project: available, committed, spent. Escrow-style milestone releases approved against evidence, with an append-only audit ledger behind every movement.",
    caps: ["Escrow-style releases", "M-Pesa records", "Audit ledger"],
  },
  {
    icon: Camera,
    name: "Evidence capture",
    description:
      "Every photo carries its GPS coordinates and timestamp. Site activity, deliveries, milestone proof — captured once on any phone, filed to the project record permanently.",
    caps: ["GPS + timestamps", "Site photos", "Milestone proof"],
  },
  {
    icon: Sparkles,
    name: "AI assistance",
    description:
      "AI reads the record, not the room. Photo observations, voice-to-log in English or Swahili, anomaly detection — with human review in the loop before anything becomes a conclusion.",
    caps: ["Photo analysis", "Voice logging", "Anomaly detection"],
  },
  {
    icon: WifiOff,
    name: "Offline sync",
    description:
      "Construction sites sit exactly where connectivity is worst. Attendance, photos, deliveries and reports capture on the device and sync when the network returns — nothing held hostage by a signal bar.",
    caps: ["Capture offline", "Auto-sync", "Visible outbox"],
  },
];

const ACCESS_NOTE =
  "Nine role surfaces over one record — client, site supervisor, contractor, professional, supplier, finance, admin. What a user can see and do is enforced server-side, not by hiding buttons.";

export function ModuleGrid() {
  return (
    <PageSection tone="paper" ariaLabel="MjengoOS modules">
      <SectionHeading
        eyebrow="The modules"
        title="Ten modules. One record between them."
        description="Every module writes to the same project record — land, people, planning, work, materials, money and evidence — so nothing is re-keyed, re-argued or re-lost between tools."
      />

      <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {MODULES.map((m, i) => (
          <Reveal key={m.name} delay={(i % 3) * 70}>
            <article className="flex h-full flex-col rounded-xl border border-ink/10 bg-white p-6 transition-all duration-200 hover:border-forest-300 hover:shadow-[0_16px_40px_-22px_rgb(23_25_24/0.3)]">
              <div className="flex items-start justify-between gap-3">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-forest-50 text-forest-700 ring-1 ring-forest-100">
                  <m.icon className="h-5 w-5" aria-hidden />
                </span>
                <span className="font-mono text-[11px] tabular-nums text-ink-faint" aria-hidden>
                  {String(i + 1).padStart(2, "0")}
                </span>
              </div>
              <h3 className="mt-4 font-display text-[17px] font-semibold text-ink">{m.name}</h3>
              <p className="mt-2.5 text-[14px] leading-relaxed text-ink-mute">{m.description}</p>
              <div className="mt-auto flex flex-wrap gap-2 pt-5">
                {m.caps.map((cap) => (
                  <span
                    key={cap}
                    className="rounded-md border border-ink/10 bg-paper px-2.5 py-1 text-[12px] font-medium text-ink-soft"
                  >
                    {cap}
                  </span>
                ))}
              </div>
            </article>
          </Reveal>
        ))}

        {/* Role-based access — closes the grid as a full-width forest card */}
        <Reveal className="sm:col-span-2 lg:col-span-3" delay={140}>
          <article className="flex flex-col gap-5 rounded-xl border border-forest-800 bg-forest-900 p-6 sm:flex-row sm:items-start lg:p-7">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-forest-800 text-earth-400 ring-1 ring-forest-700">
              <ShieldCheck className="h-5 w-5" aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-3">
                <h3 className="font-display text-[17px] font-semibold text-forest-50">Role-based access</h3>
                <span className="font-mono text-[11px] tabular-nums text-forest-300/60" aria-hidden>
                  10
                </span>
              </div>
              <p className="mt-2.5 max-w-3xl text-[14px] leading-relaxed text-forest-300/85">{ACCESS_NOTE}</p>
              <div className="mt-4 flex flex-wrap gap-2">
                {["Nine role surfaces", "Server-enforced permissions", "Least privilege"].map((cap) => (
                  <span
                    key={cap}
                    className={cn(
                      "rounded-md border border-forest-700 bg-forest-950/60 px-2.5 py-1",
                      "text-[12px] font-medium text-forest-300",
                    )}
                  >
                    {cap}
                  </span>
                ))}
              </div>
            </div>
          </article>
        </Reveal>
      </div>
    </PageSection>
  );
}

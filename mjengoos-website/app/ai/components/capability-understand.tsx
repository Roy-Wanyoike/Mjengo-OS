import { BrainCircuit, FileText, Check, AlertTriangle } from "lucide-react";
import { Reveal } from "@/components/reveal";
import { DemoChip, Badge } from "@/components/badge";

/**
 * /ai — UNDERSTAND: document and plan intelligence. Extract BOQ items
 * from a plan document and match deliveries to orders (§26).
 */
const EXTRACTIONS = [
  {
    item: "Cement · 50kg bag",
    qty: "450 bags",
    match: "ordered 450 · delivered 450",
    state: "verified" as const,
    label: "Matched",
  },
  {
    item: "Steel · D12 deformed bar",
    qty: "320 lengths",
    match: "ordered 320 · delivered 320",
    state: "verified" as const,
    label: "Matched",
  },
  {
    item: "Ballast · 3/4\u2033",
    qty: "40 m³",
    match: "order pending — procurement next",
    state: "pending" as const,
    label: "Pending",
  },
  {
    item: "BRC mesh · A142",
    qty: "85 sheets",
    match: "ordered 85 · delivered 82 — short delivery flagged",
    state: "caution" as const,
    label: "Review required",
  },
];

export function CapabilityUnderstand() {
  return (
    <Reveal delay={140} className="h-full">
      <article className="flex h-full min-w-0 flex-col overflow-hidden rounded-xl border border-ink/10 bg-white shadow-[0_24px_64px_-28px_rgb(23_25_24/0.3)]">
        <div className="flex items-center gap-3.5 border-b border-ink/10 px-5 py-4">
          <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-forest-800 text-forest-50">
            <BrainCircuit className="h-5 w-5" aria-hidden />
          </span>
          <div>
            <h3 className="font-display text-[17px] font-semibold uppercase tracking-wide text-ink">Understand</h3>
            <p className="text-[12px] text-ink-mute">Document & plan intelligence</p>
          </div>
        </div>

        <div className="flex flex-1 flex-col px-5 py-4">
          {/* Input document */}
          <div className="flex items-center gap-3 rounded-lg border border-ink/10 bg-paper px-4 py-3">
            <FileText className="h-5 w-5 shrink-0 text-forest-700" aria-hidden />
            <p className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-ink">
              BOQ — Karen Residence · PDF
            </p>
            <Badge tone="forest" className="text-[10.5px]">Analysed</Badge>
          </div>

          <p className="mt-3.5 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-ink-mute">
            Extracted items · matched to orders
          </p>
          <ul className="mt-2 flex-1 space-y-2">
            {EXTRACTIONS.map((row) => (
              <li
                key={row.item}
                className={`flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border px-3.5 py-2.5 ${
                  row.state === "caution" ? "border-caution/30 bg-caution-soft/60" : "border-ink/10 bg-white"
                }`}
              >
                <p className="min-w-0 flex-1 text-[13px] font-medium text-ink">
                  {row.item} <span className="font-normal text-ink-mute">· {row.qty}</span>
                </p>
                <p className="text-[11.5px] tabular-nums text-ink-mute">{row.match}</p>
                {row.state === "verified" && <Check className="h-4 w-4 shrink-0 text-verified" aria-hidden />}
                {row.state === "caution" && <AlertTriangle className="h-4 w-4 shrink-0 text-caution" aria-hidden />}
                {row.state === "pending" && <Badge tone="neutral" className="text-[10px]">{row.label}</Badge>}
              </li>
            ))}
          </ul>

          <div className="mt-4 flex items-start justify-between gap-3 border-t border-ink/10 pt-3.5">
            <p className="text-[11.5px] leading-relaxed text-ink-mute">
              Structure extracted from the plan; every line checked against what the project actually
              ordered and received.
            </p>
            <DemoChip className="shrink-0" />
          </div>
        </div>
      </article>
    </Reveal>
  );
}

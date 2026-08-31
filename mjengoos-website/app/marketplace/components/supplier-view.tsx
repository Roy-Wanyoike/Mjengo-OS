import { Boxes, MessageSquareText, Truck, Wallet } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { PageSection } from "@/components/page-hero";
import { SectionHeading } from "@/components/section-heading";
import { Reveal } from "@/components/reveal";
import { DemoChip, VerificationBadge } from "@/components/badge";

/**
 * /marketplace — the supplier-side view: four preview cards covering
 * products & stock, quote responses, delivery scheduling and payment
 * records. Every card demo-labelled.
 */
const CARDS: { icon: LucideIcon; title: string; rows: { label: string; note: string; state?: "verified" | "pending" | "caution"; stateLabel?: string }[]; footer: string }[] = [
  {
    icon: Boxes,
    title: "Products & stock",
    rows: [
      { label: "Cement · 50kg — KES 765", note: "1,200 bags on hand" },
      { label: "Ballast · 3/4in — KES 2,800/m³", note: "40 m³ on hand" },
      { label: "Steel · D12 — KES 1,150", note: "640 lengths on hand", state: "caution", stateLabel: "Low stock — 640 lengths" },
    ],
    footer: "Listings and stock, updated as the yard changes.",
  },
  {
    icon: MessageSquareText,
    title: "Quote responses",
    rows: [
      { label: "QR-0034 · 300 bags · Karen", note: "respond by 17:00 today", state: "pending", stateLabel: "Awaiting your quote" },
      { label: "QR-0031 · 120 bags · Kiambu", note: "quoted KES 785 · same day", state: "verified", stateLabel: "Quoted" },
    ],
    footer: "Requests arrive with quantities, location and deadline.",
  },
  {
    icon: Truck,
    title: "Delivery scheduling",
    rows: [
      { label: "PO-0029 · Thu 09:00 — Karen site", note: "dispatched · driver on route", state: "verified", stateLabel: "Dispatched" },
      { label: "PO-0026 · Fri 11:00 — Runda site", note: "loading at yard", state: "pending", stateLabel: "Scheduled" },
    ],
    footer: "Drop-offs assigned, dispatched and confirmed at the gate.",
  },
  {
    icon: Wallet,
    title: "Payment records",
    rows: [
      { label: "PO-0021 · KES 186,000", note: "M-Pesa ref recorded · 12 May", state: "verified", stateLabel: "Paid · ref on record" },
      { label: "PO-0024 · KES 94,800", note: "invoice matched · awaiting payment", state: "caution", stateLabel: "Invoice pending" },
    ],
    footer: "Invoices matched to orders; payment references recorded.",
  },
];

export function SupplierView() {
  return (
    <PageSection tone="paper" ariaLabel="The supplier side">
      <SectionHeading
        eyebrow="The supplier's side"
        title="The same trail, from the other direction."
        description="Suppliers see the market from the yard: what's in stock, what's being requested, what's on the truck, what's been paid. Four views of the same record."
      />

      <div className="mt-10 grid gap-5 sm:grid-cols-2 xl:grid-cols-4">
        {CARDS.map((card, i) => (
          <Reveal key={card.title} delay={i * 70} className="h-full">
            <article className="flex h-full flex-col overflow-hidden rounded-xl border border-ink/10 bg-white shadow-[0_1px_2px_rgb(23_25_24/0.04)]">
              <div className="flex items-center justify-between gap-2 border-b border-ink/10 px-4 py-3">
                <p className="flex items-center gap-2 font-display text-[14.5px] font-semibold text-ink">
                  <span className="flex h-7 w-7 items-center justify-center rounded-md bg-forest-50 text-forest-700 ring-1 ring-forest-100">
                    <card.icon className="h-3.5 w-3.5" aria-hidden />
                  </span>
                  {card.title}
                </p>
                <DemoChip className="scale-90" />
              </div>
              <ul className="flex-1 divide-y divide-ink/10">
                {card.rows.map((row) => (
                  <li key={row.label} className="px-4 py-3">
                    <p className="text-[13px] font-medium leading-snug text-ink">{row.label}</p>
                    <div className="mt-1 flex flex-wrap items-center justify-between gap-1.5">
                      <p className="text-[11.5px] text-ink-mute">{row.note}</p>
                      {row.state && <VerificationBadge state={row.state} label={row.stateLabel ?? ""} className="text-[10px]" />}
                    </div>
                  </li>
                ))}
              </ul>
              <p className="border-t border-ink/10 bg-paper px-4 py-2.5 text-[11px] leading-snug text-ink-mute">
                {card.footer}
              </p>
            </article>
          </Reveal>
        ))}
      </div>
    </PageSection>
  );
}

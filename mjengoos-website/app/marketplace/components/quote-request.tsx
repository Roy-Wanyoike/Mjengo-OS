import { Package, MapPin, CalendarClock, Warehouse, Check } from "lucide-react";
import { PageSection } from "@/components/page-hero";
import { SectionHeading } from "@/components/section-heading";
import { Reveal } from "@/components/reveal";
import { DemoChip, Badge } from "@/components/badge";

/**
 * /marketplace — the centerpiece: a quote-request screen mockup.
 * Request summary (material, quantity, location, deadline) + three
 * supplier quotes with a comparison state. Demo-labelled (§23-24).
 */
const QUOTES = [
  {
    name: "Supplier B",
    warehouse: "Ruaraka · Nairobi",
    perUnit: 765,
    total: "229,500",
    stock: "1,200 bags in stock",
    delivery: "next day",
    best: true,
  },
  {
    name: "Supplier A",
    warehouse: "Industrial Area · Nairobi",
    perUnit: 780,
    total: "234,000",
    stock: "4,500 bags in stock",
    delivery: "same day",
    best: false,
  },
  {
    name: "Supplier C",
    warehouse: "Ruiru depot · Kiambu",
    perUnit: 795,
    total: "238,500",
    stock: "8,000 bags in stock",
    delivery: "next day",
    best: false,
  },
];

export function QuoteRequest() {
  return (
    <PageSection tone="warm" ariaLabel="The quote request interface">
      <div className="grid items-center gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] lg:gap-16">
        {/* Copy */}
        <div className="min-w-0">
          <SectionHeading
            eyebrow="The interface"
            title="Ask the market, not a middleman."
            description="One request — material, quantity, delivery point, deadline — goes to suppliers who can actually fulfil it. Quotes come back structured, so the comparison is arithmetic, not memory."
          />
          <ul className="mt-8 space-y-4">
            {[
              "Quantities from the project's BOQ, not estimates from a phone call.",
              "Quotes that answer for stock and delivery, not just price.",
              "A selection that starts a trail — not a conversation that disappears.",
            ].map((point, i) => (
              <Reveal as="li" key={point} delay={i * 70} className="flex items-start gap-3">
                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-earth-500" aria-hidden />
                <span className="text-[15px] leading-relaxed text-ink-soft">{point}</span>
              </Reveal>
            ))}
          </ul>
        </div>

        {/* Quote-request mockup */}
        <Reveal delay={100} className="min-w-0">
          <div className="overflow-hidden rounded-xl border border-ink/10 bg-white shadow-[0_24px_64px_-28px_rgb(23_25_24/0.35)]">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-ink/10 bg-forest-900 px-5 py-4">
              <div>
                <p className="text-[10.5px] font-semibold uppercase tracking-[0.18em] text-earth-400">
                  Quote request
                </p>
                <p className="mt-0.5 font-display text-lg font-semibold text-forest-50">
                  QR-0034 · Karen Residence
                </p>
              </div>
              <DemoChip className="border-forest-700 bg-forest-950/60 text-forest-300" />
            </div>

            {/* Request summary */}
            <div className="grid grid-cols-2 divide-x divide-y divide-ink/10 border-b border-ink/10 sm:grid-cols-4 sm:divide-y-0">
              {[
                { icon: Package, label: "Material", value: "Cement · 50kg bag" },
                { icon: Warehouse, label: "Quantity", value: "300 bags" },
                { icon: MapPin, label: "Deliver to", value: "Karen, Nairobi — site gate" },
                { icon: CalendarClock, label: "Needed by", value: "Thu 15 May" },
              ].map((cell) => (
                <div key={cell.label} className="bg-white p-4">
                  <p className="flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-ink-mute">
                    <cell.icon className="h-3.5 w-3.5 text-forest-600" aria-hidden /> {cell.label}
                  </p>
                  <p className="mt-1 text-[13.5px] font-semibold text-ink">{cell.value}</p>
                </div>
              ))}
            </div>

            {/* Supplier quotes */}
            <p className="border-b border-ink/10 bg-paper px-5 py-2.5 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-ink-mute">
              3 quotes received · comparison
            </p>
            <div className="overflow-x-auto scroll-thin">
              <table className="w-full min-w-[560px] text-left text-[13.5px]">
                <thead>
                  <tr className="border-b border-ink/10 text-[10.5px] uppercase tracking-[0.14em] text-ink-mute">
                    <th scope="col" className="px-5 py-2.5 font-semibold">Supplier</th>
                    <th scope="col" className="px-3 py-2.5 font-semibold text-right">Quote</th>
                    <th scope="col" className="px-3 py-2.5 font-semibold text-right">Total · 300</th>
                    <th scope="col" className="px-3 py-2.5 font-semibold">Stock</th>
                    <th scope="col" className="px-5 py-2.5 font-semibold">Delivery</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink/10">
                  {QUOTES.map((q) => (
                    <tr
                      key={q.name}
                      className={`transition-colors ${q.best ? "bg-verified-soft/50" : "hover:bg-paper/60"}`}
                    >
                      <td className="px-5 py-3.5">
                        <p className="flex items-center gap-2 font-medium text-ink">
                          {q.best && <Check className="h-4 w-4 text-verified" aria-hidden />}
                          {q.name}
                        </p>
                        <p className="text-[11.5px] text-ink-mute">{q.warehouse}</p>
                      </td>
                      <td className="px-3 py-3.5 text-right">
                        <span className={`font-semibold tabular-nums ${q.best ? "text-verified" : "text-ink"}`}>
                          KES {q.perUnit}
                        </span>
                        {q.best && <Badge tone="verified" className="ml-2 text-[10px]">Best quote</Badge>}
                      </td>
                      <td className="px-3 py-3.5 text-right font-semibold tabular-nums text-ink">
                        KES {q.total}
                      </td>
                      <td className="px-3 py-3.5 tabular-nums text-ink-mute">{q.stock}</td>
                      <td className="px-5 py-3.5 text-ink-mute">{q.delivery}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Selection + trail footer */}
            <div className="flex flex-wrap items-center justify-between gap-2.5 border-t border-ink/10 bg-paper px-5 py-3.5">
              <p className="flex items-center gap-2 text-[13px] font-medium text-ink">
                <Check className="h-4 w-4 text-verified" aria-hidden />
                Supplier B selected — purchase order PO-0034 continues the trail
              </p>
              <span className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-ink-faint">
                PO → gate photo → invoice → payment
              </span>
            </div>
          </div>
        </Reveal>
      </div>
    </PageSection>
  );
}

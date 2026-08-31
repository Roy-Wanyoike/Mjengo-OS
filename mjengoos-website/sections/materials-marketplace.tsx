import { ArrowRight, MapPin, Package, Warehouse } from "lucide-react";
import { Container } from "@/components/container";
import { SectionHeading } from "@/components/section-heading";
import { Reveal } from "@/components/reveal";
import { Button } from "@/components/button";
import { DemoChip, Badge } from "@/components/badge";

/**
 * Materials marketplace (§23) — "Know the price before you buy."
 * Supplier comparison table with region, stock, price. Demo-labelled.
 */
const SUPPLIERS = [
  { name: "Supplier A", warehouse: "Industrial Area", region: "Nairobi", price: 780, stock: "4,500 bags", delivery: "same day" },
  { name: "Supplier B", warehouse: "Ruaraka", region: "Nairobi", price: 765, stock: "1,200 bags", delivery: "next day" },
  { name: "Supplier C", warehouse: "Ruiru depot", region: "Kiambu", price: 795, stock: "8,000 bags", delivery: "next day" },
] as const;

const BEST_PRICE = Math.min(...SUPPLIERS.map((s) => s.price));

export function MaterialsMarketplace() {
  return (
    <section aria-labelledby="materials-heading" className="border-b border-ink/10 bg-paper-warm/60">
      <Container className="py-20 lg:py-28">
        <div className="grid items-center gap-12 lg:grid-cols-[1fr_1.1fr] lg:gap-16">
          <div>
            <SectionHeading
              eyebrow="Materials marketplace"
              title={<span id="materials-heading">Know the price before you buy.</span>}
              description="Region-limited guesswork is expensive. Compare supplier prices, stock and delivery across the region — then order against the project's BOQ, with every delivery verified by photo."
            />
            <Reveal delay={120} className="mt-8 flex flex-wrap gap-3">
              <Button href="/marketplace">
                Compare Prices
                <ArrowRight className="h-4 w-4" aria-hidden />
              </Button>
              <Button href="/materials" variant="ghost">
                See how pricing works
              </Button>
            </Reveal>
          </div>

          {/* Comparison table (demo) */}
          <Reveal delay={100} className="min-w-0">
            <div className="overflow-hidden rounded-xl border border-ink/10 bg-white shadow-[0_24px_64px_-28px_rgb(23_25_24/0.35)]">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-ink/10 px-5 py-4">
                <p className="flex items-center gap-2 font-display text-[15px] font-semibold text-ink">
                  <Package className="h-4 w-4 text-earth-600" aria-hidden />
                  Cement · 50kg
                </p>
                <DemoChip />
              </div>
              <div className="overflow-x-auto scroll-thin">
                <table className="w-full min-w-[540px] text-left text-[13.5px]">
                  <thead>
                    <tr className="border-b border-ink/10 bg-paper text-[10.5px] uppercase tracking-[0.14em] text-ink-mute">
                      <th scope="col" className="px-5 py-2.5 font-semibold">Supplier</th>
                      <th scope="col" className="px-3 py-2.5 font-semibold">Region</th>
                      <th scope="col" className="px-3 py-2.5 font-semibold text-right">Price</th>
                      <th scope="col" className="px-3 py-2.5 font-semibold">Stock</th>
                      <th scope="col" className="px-5 py-2.5 font-semibold">Delivery</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ink/10">
                    {SUPPLIERS.map((s) => {
                      const isBest = s.price === BEST_PRICE;
                      return (
                        <tr key={s.name} className={`transition-colors ${isBest ? "bg-verified-soft/50" : "hover:bg-paper/60"}`}>
                          <td className="px-5 py-3.5">
                            <p className="flex items-center gap-2 font-medium text-ink">
                              <Warehouse className="h-3.5 w-3.5 text-ink-mute" aria-hidden />
                              {s.name}
                            </p>
                            <p className="text-[11.5px] text-ink-mute">{s.warehouse}</p>
                          </td>
                          <td className="px-3 py-3.5">
                            <span className="inline-flex items-center gap-1 text-ink-mute">
                              <MapPin className="h-3.5 w-3.5" aria-hidden /> {s.region}
                            </span>
                          </td>
                          <td className="px-3 py-3.5 text-right">
                            <span className={`font-semibold tabular-nums ${isBest ? "text-verified" : "text-ink"}`}>
                              KES {s.price}
                            </span>
                            {isBest && (
                              <Badge tone="verified" className="ml-2 text-[10px]">Best price</Badge>
                            )}
                          </td>
                          <td className="px-3 py-3.5 tabular-nums text-ink-mute">{s.stock}</td>
                          <td className="px-5 py-3.5 text-ink-mute">{s.delivery}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="border-t border-ink/10 bg-paper px-5 py-3 text-[11.5px] text-ink-mute">
                Illustrative prices — real supplier listings are quoted per request inside the platform.
                Quotes → purchase order → delivery photo → invoice: the whole trail stays connected.
              </p>
            </div>
          </Reveal>
        </div>
      </Container>
    </section>
  );
}

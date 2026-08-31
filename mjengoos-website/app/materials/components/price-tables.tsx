import { Package, Warehouse, MapPin } from "lucide-react";
import { PageSection } from "@/components/page-hero";
import { SectionHeading } from "@/components/section-heading";
import { Reveal } from "@/components/reveal";
import { DemoChip, Badge } from "@/components/badge";

/**
 * /materials — two price table mockups (cement 50kg + steel D12),
 * richer than the homepage's materials-marketplace pattern:
 * 4 suppliers each, best-price highlighted, demo-labelled (§23).
 */
interface SupplierRow {
  name: string;
  warehouse: string;
  region: string;
  price: string;
  stock: string;
  delivery: string;
}

interface PriceTable {
  icon: typeof Package;
  material: string;
  unit: string;
  suppliers: SupplierRow[];
  bestPrice: string;
}

const TABLES: PriceTable[] = [
  {
    icon: Package,
    material: "Cement",
    unit: "50kg bag",
    bestPrice: "KES 765",
    suppliers: [
      { name: "Supplier A", warehouse: "Industrial Area", region: "Nairobi", price: "780", stock: "4,500 bags", delivery: "same day" },
      { name: "Supplier B", warehouse: "Ruaraka", region: "Nairobi", price: "765", stock: "1,200 bags", delivery: "next day" },
      { name: "Supplier C", warehouse: "Ruiru depot", region: "Kiambu", price: "795", stock: "8,000 bags", delivery: "next day" },
      { name: "Supplier D", warehouse: "Athi River yard", region: "Machakos", price: "805", stock: "2,300 bags", delivery: "2 days" },
    ],
  },
  {
    icon: Package,
    material: "Steel",
    unit: "D12 deformed bar · 12m",
    bestPrice: "KES 1,150",
    suppliers: [
      { name: "Supplier B", warehouse: "Ruaraka", region: "Nairobi", price: "1,150", stock: "640 lengths", delivery: "next day" },
      { name: "Supplier E", warehouse: "Baba Dogo", region: "Nairobi", price: "1,185", stock: "320 lengths", delivery: "same day" },
      { name: "Supplier C", warehouse: "Ruiru depot", region: "Kiambu", price: "1,170", stock: "900 lengths", delivery: "next day" },
      { name: "Supplier F", warehouse: "Mlolongo yard", region: "Machakos", price: "1,210", stock: "150 lengths", delivery: "2 days" },
    ],
  },
];

function SupplierTable({ table }: { table: PriceTable }) {
  return (
    <div className="h-full overflow-hidden rounded-xl border border-ink/10 bg-white shadow-[0_24px_64px_-28px_rgb(23_25_24/0.3)]">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-ink/10 px-5 py-4">
        <p className="flex items-center gap-2 font-display text-[15px] font-semibold text-ink">
          <table.icon className="h-4 w-4 text-earth-600" aria-hidden />
          {table.material}
          <span className="font-normal text-ink-mute">· {table.unit}</span>
        </p>
        <DemoChip />
      </div>
      <div className="overflow-x-auto scroll-thin">
        <table className="w-full min-w-[500px] text-left text-[13.5px]">
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
            {table.suppliers.map((s) => {
              const isBest = `KES ${s.price}` === table.bestPrice;
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
      </p>
    </div>
  );
}

export function PriceTables() {
  return (
    <PageSection tone="warm" ariaLabel="Material price comparison">
      <SectionHeading
        eyebrow="Price comparison"
        title="Side by side, before you commit."
        description="Listings show indicative prices and live stock; quotes confirm the real number for your quantity and delivery point. Two of the most-traded materials, as the platform lays them out:"
      />

      <div className="mt-10 grid items-stretch gap-8 xl:grid-cols-2">
        {TABLES.map((table, i) => (
          <Reveal key={table.material} delay={i * 100} className="h-full min-w-0">
            <SupplierTable table={table} />
          </Reveal>
        ))}
      </div>

      <Reveal delay={220} className="mt-8">
        <p className="max-w-3xl text-[13px] leading-relaxed text-ink-mute">
          Cheapest is not always right: 1,200 bags in stock against a 300-bag order changes the maths less
          than 150 lengths against a 400-length order does. The comparison exists so you can see the
          trade-offs, not just the totals.
        </p>
      </Reveal>
    </PageSection>
  );
}

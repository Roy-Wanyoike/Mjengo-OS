import type { Metadata } from "next";
import { MapPin, Clock } from "lucide-react";
import { PageHero } from "@/components/page-hero";
import { Reveal } from "@/components/reveal";
import { QuoteRequest } from "./components/quote-request";
import { SupplierView } from "./components/supplier-view";
import { DeliveryLoop } from "./components/delivery-loop";
import { SuppliersBand } from "./components/suppliers-band";
import { MarketplaceCtaBand } from "./components/cta-band";

export const metadata: Metadata = {
  title: "Marketplace",
  description:
    "From quote to delivery, one trail. Request quotes from suppliers with real quantities and deadlines, compare price, stock and delivery side by side, and close every order with gate-photo delivery verification and recorded payment references.",
  alternates: { canonical: "/marketplace" },
};

/**
 * /marketplace — the supplier interface: quote-request centerpiece,
 * the supplier-side views, the delivery verification loop, the
 * for-suppliers band and the CTA.
 */
export default function MarketplacePage() {
  return (
    <>
      <PageHero
        eyebrow="Marketplace"
        title="From quote to delivery, one trail."
        description="Structured quote requests, side-by-side comparisons, verified deliveries and recorded payments — the marketplace where the region's yards and the region's sites meet on the record."
      >
        <Reveal delay={200}>
          <figure className="relative overflow-hidden rounded-xl border border-ink/10 shadow-[0_24px_64px_-28px_rgb(23_25_24/0.45)]">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/images/phone.jpg"
              alt="An engineer on a construction site in Kenya requesting material quotes on a smartphone"
              className="aspect-[21/9] w-full object-cover"
              loading="lazy"
            />
            <div className="absolute inset-x-0 bottom-0 flex flex-wrap items-center justify-between gap-2 bg-gradient-to-t from-ink/70 to-transparent px-4 pb-3 pt-10">
              <span className="text-[11.5px] font-medium text-white">
                A quote request, raised from the site — material, quantity, deadline
              </span>
              <span className="flex items-center gap-2">
                <span className="flex items-center gap-1.5 rounded-md bg-ink/75 px-2.5 py-1 font-mono text-[10.5px] text-white backdrop-blur-sm">
                  <MapPin className="h-3 w-3 text-earth-400" aria-hidden /> Karen, Nairobi
                </span>
                <span className="flex items-center gap-1.5 rounded-md bg-ink/75 px-2.5 py-1 font-mono text-[10.5px] text-white backdrop-blur-sm">
                  <Clock className="h-3 w-3 text-earth-400" aria-hidden /> needed Thu
                </span>
              </span>
            </div>
          </figure>
        </Reveal>
      </PageHero>

      <QuoteRequest />
      <SupplierView />
      <DeliveryLoop />
      <SuppliersBand />
      <MarketplaceCtaBand />
    </>
  );
}

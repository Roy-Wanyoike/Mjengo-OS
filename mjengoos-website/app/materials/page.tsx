import type { Metadata } from "next";
import { PageHero } from "@/components/page-hero";
import { PriceEditorial } from "./components/price-editorial";
import { PriceTables } from "./components/price-tables";
import { PricingSteps } from "./components/pricing-steps";
import { DeliveryVerification } from "./components/delivery-verification";
import { MaterialsCtaBand } from "./components/cta-band";

export const metadata: Metadata = {
  title: "Materials",
  description:
    "Know the price before you buy. Compare supplier prices, stock and delivery for cement, steel and more across the region — then order with a trail: gate photo, inspection count, invoice matching. Illustrative listings, real transparency.",
  alternates: { canonical: "/materials" },
};

/**
 * /materials — price transparency: the editorial on price opacity,
 * two comparison table mockups, how pricing works, the delivery
 * verification chain and the CTA.
 */
export default function MaterialsPage() {
  return (
    <>
      <PageHero
        eyebrow="Materials pricing"
        title="Know the price before you buy."
        description="Material prices across the region move with phone calls, moods and middlemen. MjengoOS puts them side by side — supplier listings, live stock, delivery windows — and keeps the whole order on a trail you can audit."
      />

      <PriceEditorial />
      <PriceTables />
      <PricingSteps />
      <DeliveryVerification />
      <MaterialsCtaBand />
    </>
  );
}

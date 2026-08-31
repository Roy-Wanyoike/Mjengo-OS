import type { Metadata } from "next";
import { ArrowRight } from "lucide-react";
import { PageHero } from "@/components/page-hero";
import { Button } from "@/components/button";
import { WalletArchitecture } from "./components/wallet-architecture";
import { ReleaseWorkflow } from "./components/release-workflow";
import { LedgerBlock } from "./components/ledger-block";
import { HonestyBand } from "./components/honesty-band";
import { WalletCtaBand } from "./components/cta-band";

export const metadata: Metadata = {
  title: "Wallet",
  description:
    "Every project deserves a financial trail. One wallet per project — available, committed and spent; milestone releases that wait for evidence and client approval; payments recorded with M-Pesa references and actors; an append-only ledger. Not a bank.",
  alternates: { canonical: "/wallet" },
};

/**
 * /wallet — the financial trail: architecture (with the milestone
 * release queue), the release workflow, the append-only ledger, the
 * not-a-bank honesty band and the CTA.
 */
export default function WalletPage() {
  return (
    <>
      <PageHero
        dark
        eyebrow="Universal wallet"
        title="Every project deserves a financial trail."
        description="Budgets, commitments, approvals, payments and reconciliation in one project-scoped record — every shilling tied to the evidence that justifies it, and every entry carrying the human behind it."
        actions={
          <>
            <Button href="/signup" size="lg">
              Start a Project
              <ArrowRight className="h-4 w-4" aria-hidden />
            </Button>
            <Button href="/contact" size="lg" variant="outline-dark">
              Talk to us
            </Button>
          </>
        }
      />

      <WalletArchitecture />
      <ReleaseWorkflow />
      <LedgerBlock />
      <HonestyBand />
      <WalletCtaBand />
    </>
  );
}

/** Shared domain types for the marketing website. */

export interface NavItem {
  label: string;
  href: string;
  /** Optional short description used in mobile menu / solutions index. */
  description?: string;
}

export interface RoleDefinition {
  slug: string;
  name: string;
  oneLiner: string;
  description: string;
  /** Module chips shown on the solutions page. */
  modules: string[];
  /** Dashboard preview cards (title + value + hint). */
  preview: { title: string; value: string; hint?: string }[];
  pains: string[];
  gains: string[];
  /** Icon name from lucide-react (resolved in components). */
  icon: string;
}

export interface PricingTier {
  name: string;
  price: string;
  period: string;
  tagline: string;
  features: string[];
  cta: { label: string; href: string };
  highlight?: boolean;
  footnote?: string;
}

export interface FaqItem {
  question: string;
  answer: string;
}

export type VerificationState = "verified" | "caution" | "pending" | "none";

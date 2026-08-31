import {
  Building,
  ClipboardCheck,
  HardHat,
  DraftingCompass,
  Truck,
  Wallet,
  type LucideIcon,
} from "lucide-react";

/**
 * RoleDefinition.icon is a string (data stays serializable); this local map
 * resolves it to a lucide component for the /solutions pages.
 */
export const ROLE_ICONS: Record<string, LucideIcon> = {
  Building,
  ClipboardCheck,
  HardHat,
  DraftingCompass,
  Truck,
  Wallet,
};

export function RoleIcon({ icon, className }: { icon: string; className?: string }) {
  const Icon = ROLE_ICONS[icon] ?? Building;
  return <Icon className={className} aria-hidden />;
}

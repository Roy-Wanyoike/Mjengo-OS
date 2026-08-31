import type { ReactNode } from "react";
import { Check, AlertTriangle, Clock, Minus } from "lucide-react";
import { cn } from "@/lib/utils";
import type { VerificationState } from "@/types";

/* ── Badge ────────────────────────────────────────────────────────────── */

type BadgeTone = "neutral" | "forest" | "earth" | "verified" | "caution" | "alert" | "dark";

const tones: Record<BadgeTone, string> = {
  neutral: "bg-paper-warm text-ink-mute border-ink/10",
  forest: "bg-forest-50 text-forest-800 border-forest-100",
  earth: "bg-earth-50 text-earth-700 border-earth-300/60",
  verified: "bg-verified-soft text-verified border-verified/25",
  caution: "bg-caution-soft text-caution border-caution/25",
  alert: "bg-alert-soft text-alert border-alert/25",
  dark: "bg-forest-900 text-forest-100 border-forest-700",
};

interface BadgeProps {
  children: ReactNode;
  tone?: BadgeTone;
  className?: string;
  /** Uppercase micro-label style. */
  caps?: boolean;
}

export function Badge({ children, tone = "neutral", className, caps = false }: BadgeProps) {
  return (
    /* relative — anchors any nested absolutely-positioned child (e.g. the
       sr-only "Status:" label) to the badge itself. Without it, the sr-only
       span's containing block becomes the section, letting it escape the
       table's scroll container and cause page-level horizontal overflow. */
    <span
      className={cn(
        "relative inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium",
        caps && "text-[10px] uppercase tracking-[0.14em] font-semibold",
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/* ── Verification badge (the product's trust language) ─────────────────── */

const stateConfig: Record<
  VerificationState,
  { label: string; tone: BadgeTone; icon: ReactNode }
> = {
  verified: { label: "Verified", tone: "verified", icon: <Check className="h-3 w-3" aria-hidden /> },
  caution: { label: "Review required", tone: "caution", icon: <AlertTriangle className="h-3 w-3" aria-hidden /> },
  pending: { label: "Pending", tone: "neutral", icon: <Clock className="h-3 w-3" aria-hidden /> },
  none: { label: "Not yet", tone: "neutral", icon: <Minus className="h-3 w-3" aria-hidden /> },
};

interface VerificationBadgeProps {
  state: VerificationState;
  /** Override label, e.g. "Licence checked". */
  label?: string;
  className?: string;
}

export function VerificationBadge({ state, label, className }: VerificationBadgeProps) {
  const cfg = stateConfig[state];
  return (
    <Badge tone={cfg.tone} className={className}>
      {cfg.icon}
      <span className="sr-only">Status:</span>
      {label ?? cfg.label}
    </Badge>
  );
}

/* ── Demo chip — honesty label for illustrative UI (§49) ───────────────── */

export function DemoChip({ className }: { className?: string }) {
  return (
    <Badge tone="neutral" caps className={cn("font-mono tracking-wider", className)}>
      Example · Demo data
    </Badge>
  );
}

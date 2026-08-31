import { cn } from "@/lib/utils";

/**
 * MjengoOS wordmark. The mark is a parcel map abstract: a boundary square
 * with a survey pin and an "M" roofline — land + structure in one glyph.
 */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      role="img"
      aria-label="MjengoOS logo"
      className={cn("h-8 w-8", className)}
    >
      {/* Parcel boundary */}
      <rect x="1.5" y="1.5" width="29" height="29" rx="6" fill="#123C32" />
      <rect x="5" y="5" width="22" height="22" rx="3.5" fill="none" stroke="#9DBDAF" strokeOpacity="0.55" strokeWidth="1" strokeDasharray="3 2.5" />
      {/* M — roofline of a structure */}
      <path
        d="M8 22.5V11.5L16 17.5L24 11.5V22.5"
        fill="none"
        stroke="#F3F2EE"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Survey pin */}
      <circle cx="16" cy="23.8" r="2.1" fill="#D9913C" />
    </svg>
  );
}

export function Logo({ className, dark = false }: { className?: string; dark?: boolean }) {
  return (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      <LogoMark />
      <span
        className={cn(
          "font-display text-[19px] font-semibold leading-none tracking-tight",
          dark ? "text-forest-50" : "text-ink",
        )}
      >
        Mjengo
        <span className={dark ? "text-earth-400" : "text-earth-500"}>OS</span>
      </span>
    </span>
  );
}

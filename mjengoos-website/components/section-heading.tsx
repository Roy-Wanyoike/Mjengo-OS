import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Reveal } from "@/components/reveal";

interface SectionHeadingProps {
  eyebrow?: string;
  title: ReactNode;
  description?: ReactNode;
  align?: "left" | "center";
  className?: string;
  /** Dark sections invert text colors. */
  dark?: boolean;
}

/** Consistent section headers: eyebrow + display headline + description. */
export function SectionHeading({
  eyebrow,
  title,
  description,
  align = "left",
  className,
  dark = false,
}: SectionHeadingProps) {
  return (
    <Reveal
      className={cn(
        "max-w-3xl",
        align === "center" && "mx-auto text-center",
        className,
      )}
    >
      {eyebrow && (
        <p
          className={cn(
            "mb-3 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em]",
            align === "center" && "justify-center",
            dark ? "text-earth-400" : "text-earth-600",
          )}
        >
          <span className={cn("inline-block h-px w-6", dark ? "bg-earth-400/70" : "bg-earth-500/70")} aria-hidden />
          {eyebrow}
        </p>
      )}
      <h2
        className={cn(
          "font-display text-3xl font-semibold leading-[1.08] tracking-tight text-balance sm:text-4xl",
          dark ? "text-forest-50" : "text-ink",
        )}
      >
        {title}
      </h2>
      {description && (
        <p
          className={cn(
            "mt-4 text-base leading-relaxed sm:text-lg",
            dark ? "text-forest-300/90" : "text-ink-mute",
          )}
        >
          {description}
        </p>
      )}
    </Reveal>
  );
}

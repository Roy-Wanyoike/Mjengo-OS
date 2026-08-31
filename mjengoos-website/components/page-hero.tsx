import type { ReactNode } from "react";
import { Container } from "@/components/container";
import { Reveal } from "@/components/reveal";
import { MapVisual } from "@/components/map-visual";
import { cn } from "@/lib/utils";

/**
 * Shared hero band for subpages — eyebrow, headline, description, optional
 * actions. Keeps every page visually consistent.
 */
export function PageHero({
  eyebrow,
  title,
  description,
  actions,
  dark = false,
  children,
}: {
  eyebrow: string;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  dark?: boolean;
  children?: ReactNode;
}) {
  return (
    <section
      className={cn(
        "relative overflow-hidden border-b border-ink/10",
        dark ? "bg-forest-950" : "bg-paper-warm/70",
      )}
    >
      {!dark && <div className="absolute inset-0 bg-survey-grid" aria-hidden />}
      {dark && (
        <>
          <div className="absolute inset-0 bg-survey-grid-dark" aria-hidden />
          <div className="absolute inset-0 opacity-50" aria-hidden>
            <MapVisual dark className="h-full w-full" />
          </div>
        </>
      )}
      <Container className={cn("relative py-16 sm:py-20 lg:py-24")}>
        <Reveal className="max-w-3xl">
          <p
            className={cn(
              "mb-3 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em]",
              dark ? "text-earth-400" : "text-earth-600",
            )}
          >
            <span className={cn("inline-block h-px w-6", dark ? "bg-earth-400/70" : "bg-earth-500/70")} aria-hidden />
            {eyebrow}
          </p>
          <h1
            className={cn(
              "font-display text-4xl font-semibold leading-[1.06] tracking-tight text-balance sm:text-5xl",
              dark ? "text-forest-50" : "text-ink",
            )}
          >
            {title}
          </h1>
          {description && (
            <p
              className={cn(
                "mt-5 max-w-2xl text-lg leading-relaxed",
                dark ? "text-forest-300/90" : "text-ink-mute",
              )}
            >
              {description}
            </p>
          )}
          {actions && <div className="mt-8 flex flex-wrap items-center gap-3">{actions}</div>}
        </Reveal>
        {children && <div className="relative mt-10">{children}</div>}
      </Container>
    </section>
  );
}

/**
 * Compact section wrapper for subpage content blocks.
 */
export function PageSection({
  children,
  className,
  tone = "paper",
  id,
  ariaLabel,
}: {
  children: ReactNode;
  className?: string;
  tone?: "paper" | "warm" | "forest" | "dark";
  id?: string;
  ariaLabel?: string;
}) {
  const tones = {
    paper: "bg-paper",
    warm: "bg-paper-warm/60",
    forest: "bg-forest-950 text-forest-100",
    dark: "bg-forest-900 text-forest-100",
  };
  return (
    <section
      id={id}
      aria-label={ariaLabel}
      className={cn("border-b border-ink/10", tones[tone], className)}
    >
      <Container className="py-16 sm:py-20">{children}</Container>
    </section>
  );
}

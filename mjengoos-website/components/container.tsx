import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

/** Page-width container with consistent horizontal rhythm. */
export function Container({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "mx-auto w-full max-w-6xl px-4 sm:px-6 lg:px-8",
        // Slightly wider for dense product layouts
        className,
      )}
      {...props}
    />
  );
}

/** Wider variant for full-bleed product mockups. */
export function WideContainer({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("mx-auto w-full max-w-7xl px-4 sm:px-6 lg:px-8", className)} {...props} />;
}

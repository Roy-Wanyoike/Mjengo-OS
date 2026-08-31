import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";

type Variant = "primary" | "secondary" | "ghost" | "dark" | "outline-dark";
type Size = "sm" | "md" | "lg";

const base =
  "inline-flex items-center justify-center gap-2 font-medium tracking-tight transition-all duration-200 focus-visible:outline-2 focus-visible:outline-offset-2 rounded-md disabled:opacity-60 disabled:pointer-events-none";

const variants: Record<Variant, string> = {
  primary:
    "bg-earth-500 text-ink hover:bg-earth-400 shadow-[0_1px_2px_rgb(23_25_24/0.2),0_8px_24px_-12px_rgb(217_145_60/0.6)] active:translate-y-px focus-visible:outline-earth-700",
  secondary:
    "bg-forest-800 text-forest-50 hover:bg-forest-700 shadow-[0_1px_2px_rgb(23_25_24/0.25),0_10px_28px_-14px_rgb(18_60_50/0.7)] active:translate-y-px focus-visible:outline-forest-800",
  dark: "bg-ink text-paper hover:bg-ink-soft focus-visible:outline-ink",
  ghost:
    "text-ink hover:bg-ink/[0.05] border border-transparent hover:border-ink/10 focus-visible:outline-ink",
  "outline-dark":
    "border border-forest-100/40 text-forest-50 hover:bg-forest-50/10 focus-visible:outline-forest-300",
};

const sizes: Record<Size, string> = {
  sm: "h-9 px-3.5 text-sm",
  md: "h-11 px-5 text-[15px]",
  lg: "h-12 px-6 text-base",
};

interface ButtonProps extends Omit<ComponentProps<typeof Link>, "className" | "children"> {
  variant?: Variant;
  size?: Size;
  children: ReactNode;
  className?: string;
}

/** Link styled as a button — every CTA on the site is a real link (§46). */
export function Button({ variant = "primary", size = "md", className, children, ...props }: ButtonProps) {
  return (
    <Link className={cn(base, variants[variant], sizes[size], className)} {...props}>
      {children}
    </Link>
  );
}

/** Plain <button> with the same visual system (for form submits etc.). */
export function ActionButton({
  variant = "primary",
  size = "md",
  className,
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size }) {
  return (
    <button className={cn(base, variants[variant], sizes[size], className)} {...props}>
      {children}
    </button>
  );
}

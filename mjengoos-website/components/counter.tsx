"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

interface CounterProps {
  to: number;
  /** e.g. "KES 4,200,000" → prefix "KES " with formatted number. */
  prefix?: string;
  suffix?: string;
  duration?: number;
  className?: string;
  /** Rendered until the counter starts (and for reduced-motion users). */
  formatted?: string;
}

function defaultFormat(n: number) {
  return n.toLocaleString("en-KE");
}

/**
 * Animated number counter that starts when scrolled into view.
 * Respects prefers-reduced-motion (renders the final value immediately).
 */
export function Counter({ to, prefix = "", suffix = "", duration = 1400, className, formatted }: CounterProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const [display, setDisplay] = useState(() => formatted ?? `${prefix}${defaultFormat(to)}${suffix}`);
  const started = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const finalText = formatted ?? `${prefix}${defaultFormat(to)}${suffix}`;

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      // Initial state already renders the final text — nothing to animate.
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting) || started.current) return;
        started.current = true;
        observer.disconnect();

        const start = performance.now();
        const tick = (now: number) => {
          const t = Math.min(1, (now - start) / duration);
          // ease-out cubic — numbers decelerate into place
          const eased = 1 - Math.pow(1 - t, 3);
          setDisplay(`${prefix}${defaultFormat(Math.round(to * eased))}${suffix}`);
          if (t < 1) requestAnimationFrame(tick);
          else setDisplay(finalText);
        };
        requestAnimationFrame(tick);
      },
      { threshold: 0.4 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [to, prefix, suffix, duration, formatted]);

  return (
    <span ref={ref} className={cn("tabular-nums", className)}>
      {display}
    </span>
  );
}

"use client";

import { useEffect, useState } from "react";
import { Camera, MapPin, Clock, CheckCircle2, Truck, FileText } from "lucide-react";
import { ParcelMap } from "@/components/map-visual";
import { DemoChip } from "@/components/badge";
import { asset, cn } from "@/lib/utils";

/**
 * The hero product visual — a real composition of the MjengoOS project
 * dashboard (§13): progress, budget, milestone, evidence cards, map.
 * Demo data throughout; labelled honestly. Animations: progress fill +
 * metric counters run once on mount (respecting reduced-motion).
 */

const PROGRESS = 68;

export function DashboardMockup({ className }: { className?: string }) {
  // Initial state = final values: reduced-motion users and pre-animation
  // paint both show the destination numbers; the mount effect runs the
  // count-up only when motion is allowed (rAF ticks are async). Card
  // entrances are pure CSS (fadeSlide keyframes) — automatically disabled
  // by the global prefers-reduced-motion rule.
  const [progress, setProgress] = useState(PROGRESS);
  const [budget, setBudget] = useState(4200000);
  const [spent, setSpent] = useState(2300000);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const start = performance.now();
    const duration = 1600;
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      setProgress(Math.round(PROGRESS * eased));
      setBudget(Math.round(4200000 * eased));
      setSpent(Math.round(2300000 * eased));
      if (p < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, []);

  const kes = (n: number) => `KES ${n.toLocaleString("en-KE")}`;

  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-xl border border-ink/10 bg-white shadow-[0_1px_2px_rgb(23_25_24/0.08),0_24px_64px_-24px_rgb(23_25_24/0.35)]",
        className,
      )}
      role="img"
      aria-label="MjengoOS project dashboard (example project, demo data): Karen Residence at 68% progress, KES 4.2M budget, roofing milestone next, with site photo, materials and project map cards"
    >
      {/* Browser chrome */}
      <div className="flex items-center gap-3 border-b border-ink/10 bg-paper-warm px-4 py-2.5">
        <div className="flex gap-1.5" aria-hidden>
          <span className="h-2.5 w-2.5 rounded-full bg-ink/15" />
          <span className="h-2.5 w-2.5 rounded-full bg-ink/15" />
          <span className="h-2.5 w-2.5 rounded-full bg-ink/15" />
        </div>
        <div className="mx-auto flex h-6 w-full max-w-[280px] items-center justify-center rounded-full bg-white px-3 font-mono text-[10.5px] text-ink-mute ring-1 ring-ink/10">
          app.mjengoos.ke/projects/karen-residence
        </div>
        <DemoChip className="hidden sm:inline-flex" />
      </div>

      {/* App header */}
      <div className="flex items-center justify-between border-b border-ink/10 px-4 py-3 sm:px-5">
        <div className="flex items-center gap-2.5">
          <svg viewBox="0 0 32 32" className="h-7 w-7" aria-hidden>
            <rect x="1.5" y="1.5" width="29" height="29" rx="6" fill="#123C32" />
            <path d="M8 22.5V11.5L16 17.5L24 11.5V22.5" fill="none" stroke="#F3F2EE" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
            <circle cx="16" cy="23.8" r="2.1" fill="#D9913C" />
          </svg>
          <div className="min-w-0">
            <p className="truncate text-[13.5px] font-semibold leading-tight text-ink">Karen Residence</p>
            <p className="text-[11px] leading-tight text-ink-mute">Nairobi · Day 47</p>
          </div>
        </div>
        <span className="flex items-center gap-1.5 rounded-full bg-forest-50 px-2.5 py-1 text-[10.5px] font-semibold uppercase tracking-wider text-forest-800 ring-1 ring-forest-100">
          <span className="relative flex h-1.5 w-1.5" aria-hidden>
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-verified opacity-60" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-verified" />
          </span>
          Active
        </span>
      </div>

      {/* Project progress + budget row */}
      <div className="grid gap-4 px-4 py-5 sm:grid-cols-[1.2fr_1fr] sm:px-5">
        <div>
          <div className="flex items-baseline justify-between">
            <p className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-ink-mute">Project progress</p>
            <p className="font-display text-2xl font-semibold tabular-nums text-ink">
              {progress}
              <span className="text-sm text-ink-mute">%</span>
            </p>
          </div>
          <div className="mt-2.5 h-2 overflow-hidden rounded-full bg-ink/10" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100} aria-label="Project progress">
            <div
              className="h-full rounded-full bg-gradient-to-r from-forest-600 to-forest-500 transition-[width] duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
          <p className="mt-2 text-[11px] text-ink-mute">photo-verified · updated today 14:32 EAT</p>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-lg border border-ink/10 bg-paper px-3 py-2.5">
            <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-mute">Budget</p>
            <p className="mt-1 font-display text-[15px] font-semibold tabular-nums text-ink">{kes(budget)}</p>
          </div>
          <div className="rounded-lg border border-ink/10 bg-paper px-3 py-2.5">
            <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-mute">Spent</p>
            <p className="mt-1 font-display text-[15px] font-semibold tabular-nums text-ink">{kes(spent)}</p>
            <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-ink/10">
              <div className="h-full rounded-full bg-earth-500" style={{ width: "54%" }} />
            </div>
          </div>
        </div>
      </div>

      {/* Next milestone */}
      <div className="mx-4 mb-4 flex items-center justify-between rounded-lg border border-earth-300/50 bg-earth-50 px-4 py-3 sm:mx-5">
        <div className="flex items-center gap-3">
          <FileText className="h-4 w-4 text-earth-600" aria-hidden />
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-earth-700">Next milestone</p>
            <p className="text-[13.5px] font-semibold text-ink">Roofing — awaiting evidence</p>
          </div>
        </div>
        <span className="text-[12px] font-semibold tabular-nums text-earth-700">KES 650,000</span>
      </div>

      {/* Evidence cards */}
      <div className="grid grid-cols-3 gap-3 px-4 pb-5 sm:px-5">
        <EvidenceCard
          icon={<Camera className="h-3.5 w-3.5" aria-hidden />}
          title="Site photo"
          value="5 new"
          sub="GPS + timestamp"
          imageUrl={asset("/images/site-photo.jpg")}
          delay={0}
        />
        <EvidenceCard
          icon={<Truck className="h-3.5 w-3.5" aria-hidden />}
          title="Materials"
          value="120 bags"
          sub="cement delivered"
          delay={120}
        />
        <EvidenceCard
          icon={<MapPin className="h-3.5 w-3.5" aria-hidden />}
          title="Project map"
          value="5 zones"
          sub="site plan"
          map
          delay={240}
        />
      </div>

      {/* Floating verification chip (desktop only) */}
      <div
        className="absolute right-3 top-[104px] hidden items-center gap-2 rounded-full border border-ink/10 bg-white/95 px-3 py-1.5 text-[11px] font-medium text-ink shadow-lg backdrop-blur md:flex"
        style={{ animation: "fadeSlide 0.7s 500ms cubic-bezier(0.16, 1, 0.3, 1) both" }}
      >
        <CheckCircle2 className="h-3.5 w-3.5 text-verified" aria-hidden />
        Evidence attached
        <span className="font-mono text-[10px] text-ink-mute">-1.3190, 36.7765</span>
      </div>
    </div>
  );
}

function EvidenceCard({
  icon,
  title,
  value,
  sub,
  imageUrl,
  map,
  delay,
}: {
  icon: React.ReactNode;
  title: string;
  value: string;
  sub: string;
  imageUrl?: string;
  map?: boolean;
  delay: number;
}) {
  return (
    <div
      className="overflow-hidden rounded-lg border border-ink/10 bg-white"
      style={{ animation: `fadeSlide 0.5s ${delay}ms cubic-bezier(0.16, 1, 0.3, 1) both` }}
    >
      {imageUrl && (
        <div className="relative h-16 w-full bg-paper-warm sm:h-20">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={imageUrl} alt="" className="h-full w-full object-cover" loading="lazy" />
          <span className="absolute bottom-1 left-1 flex items-center gap-1 rounded bg-ink/70 px-1.5 py-0.5 font-mono text-[8.5px] text-white">
            <Clock className="h-2.5 w-2.5" aria-hidden /> 14:32
          </span>
        </div>
      )}
      {map && (
        <div className="h-16 w-full sm:h-20">
          <ParcelMap className="h-full w-full rounded-none" pinLabel="PLOT 209/12345" />
        </div>
      )}
      {!imageUrl && !map && (
        <div className="flex h-16 w-full items-center justify-center bg-forest-50 sm:h-20">
          <Truck className="h-5 w-5 text-forest-600" aria-hidden />
        </div>
      )}
      <div className="flex items-center justify-between px-2.5 py-2">
        <div className="min-w-0">
          <p className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-ink-mute">
            {icon} {title}
          </p>
          <p className="truncate text-[12.5px] font-semibold text-ink">{value}</p>
        </div>
      </div>
      <p className="px-2.5 pb-2 text-[10px] text-ink-mute">{sub}</p>
    </div>
  );
}

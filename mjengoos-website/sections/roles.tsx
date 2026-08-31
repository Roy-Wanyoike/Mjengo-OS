"use client";

import { useState } from "react";
import { Container } from "@/components/container";
import { SectionHeading } from "@/components/section-heading";
import { Reveal } from "@/components/reveal";
import { DemoChip } from "@/components/badge";
import { SWITCHER_ROLES } from "@/data/roles";
import { cn } from "@/lib/utils";
import { track } from "@/lib/analytics";

/**
 * Role-based experience (§30) — interactive role selector.
 * Changing the role changes the dashboard preview.
 */
export function Roles() {
  const [active, setActive] = useState(0);
  const role = SWITCHER_ROLES[active];

  return (
    <section aria-labelledby="roles-heading" className="border-b border-ink/10 bg-paper-warm/60">
      <Container className="py-20 lg:py-28">
        <SectionHeading
          eyebrow="Role-based experience"
          title={<span id="roles-heading">One record. Nine points of view.</span>}
          description="The same project, shaped for the person looking at it — a client in Dubai, a supervisor on site, a supplier in Industrial Area. Switch roles to see each surface."
        />

        {/* Role selector */}
        <Reveal delay={100} className="mt-10">
          <div
            role="tablist"
            aria-label="Choose a role to preview its dashboard"
            className="flex flex-wrap gap-2"
          >
            {SWITCHER_ROLES.map((r, i) => (
              <button
                key={r.slug}
                role="tab"
                aria-selected={i === active}
                aria-controls="role-panel"
                id={`role-tab-${r.slug}`}
                onClick={() => {
                  setActive(i);
                  track("role_switched", { role: r.slug });
                }}
                className={cn(
                  "h-11 rounded-lg border px-4 text-[14px] font-medium transition-all duration-150",
                  i === active
                    ? "border-forest-800 bg-forest-800 text-forest-50 shadow-[0_6px_20px_-8px_rgb(18_60_50/0.6)]"
                    : "border-ink/10 bg-white text-ink-mute hover:border-forest-300 hover:text-ink",
                )}
              >
                {r.name}
              </button>
            ))}
          </div>
        </Reveal>

        {/* Dashboard preview panel */}
        <Reveal delay={150} className="mt-6">
          <div
            id="role-panel"
            role="tabpanel"
            aria-labelledby={`role-tab-${role.slug}`}
            className="overflow-hidden rounded-xl border border-ink/10 bg-white shadow-[0_24px_64px_-28px_rgb(23_25_24/0.3)]"
          >
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-ink/10 bg-forest-900 px-5 py-4">
              <div className="flex items-center gap-3.5">
                <div className="flex h-9 w-9 items-center justify-center rounded-md bg-forest-800 font-display text-[15px] font-bold text-earth-400">
                  {role.name.charAt(0)}
                </div>
                <div>
                  <p className="font-display text-[16px] font-semibold text-forest-50">{role.name} view</p>
                  <p className="text-[11.5px] text-forest-300/80">
                    {role.preview.length} modules · scoped to one project
                  </p>
                </div>
              </div>
              <DemoChip className="border-forest-700 bg-forest-950/60 text-forest-300" />
            </div>

            {/* Module chips */}
            <div className="flex flex-wrap gap-2 border-b border-ink/10 bg-paper px-5 py-3.5">
              {role.modules.map((m) => (
                <span key={m} className="rounded-md border border-ink/10 bg-white px-2.5 py-1 text-[12px] font-medium text-ink-soft">
                  {m}
                </span>
              ))}
            </div>

            {/* Preview cards */}
            <div key={role.slug} className="grid gap-px bg-ink/10 sm:grid-cols-2 lg:grid-cols-4">
              {role.preview.map((cell, i) => (
                <div
                  key={cell.title}
                  className="bg-white p-5 transition-all duration-300"
                  style={{ animation: `fadeSlide 0.4s ${i * 60}ms var(--ease-expo, ease-out) both` }}
                >
                  <p className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-ink-mute">{cell.title}</p>
                  <p className="mt-2 font-display text-[22px] font-semibold leading-tight text-ink">
                    {cell.value}
                  </p>
                  {cell.hint && <p className="mt-1 text-[12px] text-ink-mute">{cell.hint}</p>}
                </div>
              ))}
            </div>

            <p className="border-t border-ink/10 bg-paper px-5 py-3 text-[11.5px] text-ink-mute">
              Role determines what a user can see and do — enforced server-side, not just hidden buttons.
            </p>
          </div>
        </Reveal>
      </Container>

      <style>{`
        @keyframes fadeSlide {
          from { opacity: 0; transform: translateY(8px); }
          to { opacity: 1; transform: none; }
        }
      `}</style>
    </section>
  );
}

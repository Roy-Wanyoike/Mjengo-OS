import { DemoChip } from "@/components/badge";
import { Reveal } from "@/components/reveal";
import { RoleIcon } from "./role-icon";
import type { RoleDefinition } from "@/types";

/**
 * /solutions/[slug] — "Your surface": a static rendering of the role's
 * dashboard preview, following the homepage Roles section panel pattern
 * (forest header → module chips → preview cards → server-side note).
 * Demo-labelled (§49).
 */
export function RoleSurface({ role }: { role: RoleDefinition }) {
  return (
    <Reveal delay={120}>
      <div className="overflow-hidden rounded-xl border border-ink/10 bg-white shadow-[0_24px_64px_-28px_rgb(23_25_24/0.3)]">
        {/* Panel header */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-ink/10 bg-forest-900 px-5 py-4">
          <div className="flex items-center gap-3.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-md bg-forest-800 text-earth-400 ring-1 ring-forest-700">
              <RoleIcon icon={role.icon} className="h-4.5 w-4.5" />
            </div>
            <div>
              <p className="font-display text-[16px] font-semibold text-forest-50">{role.name} view</p>
              <p className="text-[11.5px] text-forest-300/80">
                {role.preview.length} cards · scoped to one project
              </p>
            </div>
          </div>
          <DemoChip className="border-forest-700 bg-forest-950/60 text-forest-300" />
        </div>

        {/* Module chips */}
        <div className="flex flex-wrap gap-2 border-b border-ink/10 bg-paper px-5 py-3.5">
          {role.modules.map((m) => (
            <span
              key={m}
              className="rounded-md border border-ink/10 bg-white px-2.5 py-1 text-[12px] font-medium text-ink-soft"
            >
              {m}
            </span>
          ))}
        </div>

        {/* Preview cards */}
        <div className="grid gap-px bg-ink/10 sm:grid-cols-2 lg:grid-cols-4">
          {role.preview.map((cell) => (
            <div key={cell.title} className="bg-white p-5">
              <p className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-ink-mute">
                {cell.title}
              </p>
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
  );
}

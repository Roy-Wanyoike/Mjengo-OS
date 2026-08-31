import { ArrowRight } from "lucide-react";
import { Reveal } from "@/components/reveal";
import { SiteLink } from "@/components/site-link";
import { RoleIcon } from "./role-icon";
import type { RoleDefinition } from "@/types";

/**
 * /solutions index — one card per role: icon, name, one-liner, module chips
 * and an "Explore" link to the role page. The whole card is the link.
 */
export function RoleCards({ roles }: { roles: RoleDefinition[] }) {
  return (
    <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
      {roles.map((role, i) => (
        <Reveal key={role.slug} delay={(i % 3) * 70}>
          <SiteLink
            href={`/solutions/${role.slug}`}
            className="group flex h-full flex-col rounded-xl border border-ink/10 bg-white p-6 transition-all duration-200 hover:border-forest-300 hover:shadow-[0_16px_40px_-22px_rgb(23_25_24/0.3)]"
          >
            <div className="flex items-start justify-between gap-3">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-forest-50 text-forest-700 ring-1 ring-forest-100">
                <RoleIcon icon={role.icon} className="h-5.5 w-5.5" />
              </span>
              <span className="flex items-center gap-1 text-[13px] font-semibold text-forest-700 transition-all duration-200 group-hover:gap-2 group-hover:text-forest-800">
                Explore
                <ArrowRight className="h-4 w-4" aria-hidden />
              </span>
            </div>

            <h3 className="mt-4 font-display text-xl font-semibold text-ink">{role.name}</h3>
            <p className="mt-1.5 text-[14px] leading-relaxed text-ink-mute">{role.oneLiner}</p>

            <div className="mt-auto flex flex-wrap gap-2 pt-5">
              {role.modules.slice(0, 4).map((m) => (
                <span
                  key={m}
                  className="rounded-md border border-ink/10 bg-paper px-2.5 py-1 text-[12px] font-medium text-ink-soft"
                >
                  {m}
                </span>
              ))}
              {role.modules.length > 4 && (
                <span className="rounded-md border border-ink/10 bg-paper px-2.5 py-1 text-[12px] font-medium text-ink-mute">
                  +{role.modules.length - 4} more
                </span>
              )}
            </div>
          </SiteLink>
        </Reveal>
      ))}
    </div>
  );
}

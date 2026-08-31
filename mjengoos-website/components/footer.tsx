import { Logo } from "@/components/logo";
import { SiteLink } from "@/components/site-link";
import { FOOTER_COLUMNS } from "@/data/nav";
import { SITE } from "@/lib/site";

export function Footer() {
  return (
    <footer className="bg-forest-950 text-forest-100">
      <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6 lg:px-8 lg:py-16">
        <div className="grid gap-10 md:grid-cols-[1.4fr_repeat(4,1fr)] md:gap-8">
          {/* Brand block */}
          <div className="max-w-xs">
            <SiteLink href="/" aria-label="MjengoOS home" className="inline-block">
              <Logo dark />
            </SiteLink>
            <p className="mt-4 text-sm leading-relaxed text-forest-300/90">
              The operating system for real-world construction.
            </p>
            <p className="mt-2 text-xs text-forest-300/70">
              {SITE.expansion}
            </p>
          </div>

          {/* Link columns */}
          {FOOTER_COLUMNS.map((col) => (
            <nav key={col.title} aria-label={`Footer — ${col.title}`}>
              <h3 className="text-[11px] font-semibold uppercase tracking-[0.18em] text-forest-300/70">
                {col.title}
              </h3>
              <ul className="mt-4 space-y-2.5">
                {col.items.map((item) => (
                  <li key={item.href + item.label}>
                    <SiteLink
                      href={item.href}
                      className="text-sm text-forest-100/80 transition-colors hover:text-earth-300"
                    >
                      {item.label}
                    </SiteLink>
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>

        <div className="mt-12 flex flex-col gap-4 border-t border-forest-800 pt-8 text-xs text-forest-300/60 sm:flex-row sm:items-center sm:justify-between">
          <p>© {new Date().getFullYear()} MjengoOS. Built in Kenya.</p>
          <p className="font-mono tracking-wide text-forest-300/50">
            LAND + PEOPLE + MATERIALS + MONEY + EVIDENCE
          </p>
        </div>
      </div>
    </footer>
  );
}

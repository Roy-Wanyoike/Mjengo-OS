import { MapPin, Star } from "lucide-react";
import { PageSection } from "@/components/page-hero";
import { SectionHeading } from "@/components/section-heading";
import { Reveal } from "@/components/reveal";
import { DemoChip, VerificationBadge } from "@/components/badge";

/**
 * /professionals — the directory preview mockup: three illustrative
 * professional cards with the verification language. Demo-labelled;
 * generic example names, not real listings.
 */
const DIRECTORY: {
  initials: string;
  name: string;
  title: string;
  county: string;
  area: string;
  body: string;
}[] = [
  {
    initials: "JM",
    name: "J. Mwangi",
    title: "Licensed Surveyor",
    county: "Nairobi",
    area: "Nairobi · Kiambu · Kajiado",
    body: "Land Surveyors Board",
  },
  {
    initials: "AW",
    name: "A. Wairimu",
    title: "Advocate",
    county: "Kiambu",
    area: "Kiambu · Nairobi · Nakuru",
    body: "Law Society of Kenya",
  },
  {
    initials: "EO",
    name: "E. Otieno",
    title: "Structural Engineer",
    county: "Nakuru",
    area: "Nakuru · Nairobi · Kisumu",
    body: "Engineers Board of Kenya",
  },
];

export function DirectoryPreview() {
  return (
    <PageSection tone="warm" ariaLabel="Directory preview">
      <SectionHeading
        eyebrow="Directory preview"
        title="Find the right professional, with the record attached."
        description="Clients browse by trade and county — and see more than a name: licence reference recorded, service area, and work that has landed in project records."
      />

      <div className="mt-10 overflow-hidden rounded-xl border border-ink/10 bg-white shadow-[0_24px_64px_-28px_rgb(23_25_24/0.3)]">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-ink/10 bg-forest-900 px-5 py-4">
          <div>
            <p className="text-[10.5px] font-semibold uppercase tracking-[0.18em] text-earth-400">
              Professional directory
            </p>
            <p className="mt-0.5 font-display text-lg font-semibold text-forest-50">
              Search · Licensed professionals · Kenya
            </p>
          </div>
          <DemoChip className="border-forest-700 bg-forest-950/60 text-forest-300" />
        </div>

        <ul className="divide-y divide-ink/10">
          {DIRECTORY.map((p, i) => (
            <Reveal as="li" key={p.name} delay={i * 60}>
              <div className="flex flex-wrap items-center gap-4 px-5 py-4 sm:flex-nowrap">
                <span
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-forest-50 font-display text-[14px] font-semibold text-forest-800 ring-1 ring-forest-100"
                  aria-hidden
                >
                  {p.initials}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-[15px] font-semibold text-ink">
                    {p.name} <span className="font-normal text-ink-mute">— {p.title}</span>
                  </p>
                  <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-ink-mute">
                    <span className="inline-flex items-center gap-1">
                      <MapPin className="h-3.5 w-3.5" aria-hidden /> {p.county}
                    </span>
                    <span>Serves: {p.area}</span>
                    <span className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-ink-faint">{p.body}</span>
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <span className="inline-flex items-center gap-1 text-[12px] text-ink-mute">
                    <Star className="h-3.5 w-3.5 text-earth-500" aria-hidden />
                    Rated after completed assignments
                  </span>
                  <VerificationBadge state="verified" label="Licence checked" />
                </div>
              </div>
            </Reveal>
          ))}
        </ul>

        <p className="border-t border-ink/10 bg-paper px-5 py-3 text-[11.5px] leading-relaxed text-ink-mute">
          Illustrative directory entries — names are examples, not listings. Every real profile carries its
          own recorded licence reference before assignments open.
        </p>
      </div>
    </PageSection>
  );
}

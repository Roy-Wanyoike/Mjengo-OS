import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ArrowRight, CheckCircle2, X, AlertTriangle } from "lucide-react";
import { PageHero, PageSection } from "@/components/page-hero";
import { SectionHeading } from "@/components/section-heading";
import { Button } from "@/components/button";
import { Reveal } from "@/components/reveal";
import { SiteLink } from "@/components/site-link";
import { MapVisual } from "@/components/map-visual";
import { ROLES } from "@/data/roles";
import { RoleSurface } from "../components/role-surface";

/**
 * /solutions/[slug] — one role page per ROLES entry: pains vs gains, the
 * role's surface preview, its module list, cross-links to the other roles
 * and a closing CTA. Statically generated for all six slugs.
 */

export function generateStaticParams() {
  return ROLES.map((role) => ({ slug: role.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const role = ROLES.find((r) => r.slug === slug);
  if (!role) return { title: "Solution not found" };
  return {
    title: `${role.name} solution`,
    description: role.oneLiner,
    alternates: { canonical: `/solutions/${role.slug}` },
  };
}

export default async function RoleSolutionPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const role = ROLES.find((r) => r.slug === slug);
  if (!role) notFound();

  const otherRoles = ROLES.filter((r) => r.slug !== role.slug);

  return (
    <>
      <PageHero
        eyebrow={`Solutions — ${role.name}`}
        title={role.name}
        description={role.oneLiner}
      />

      {/* The problem today vs With MjengoOS */}
      <PageSection tone="paper" ariaLabel="The problem today, and with MjengoOS">
        <div className="grid gap-6 lg:grid-cols-2 lg:gap-8">
          <Reveal>
            <article className="h-full rounded-xl border border-ink/10 bg-white p-6 sm:p-7">
              <div className="flex items-center gap-3">
                <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-alert-soft text-alert ring-1 ring-alert/20">
                  <AlertTriangle className="h-4.5 w-4.5" aria-hidden />
                </span>
                <h2 className="font-display text-xl font-semibold text-ink">The problem today</h2>
              </div>
              <ul className="mt-6 space-y-4">
                {role.pains.map((pain) => (
                  <li key={pain} className="flex items-start gap-3">
                    <span className="mt-0.5 flex h-5.5 w-5.5 shrink-0 items-center justify-center rounded-full bg-alert-soft text-alert">
                      <X className="h-3.5 w-3.5" aria-hidden />
                    </span>
                    <span className="text-[15px] leading-relaxed text-ink-soft">{pain}</span>
                  </li>
                ))}
              </ul>
            </article>
          </Reveal>

          <Reveal delay={120}>
            <article className="h-full rounded-xl border border-ink/10 bg-white p-6 sm:p-7">
              <div className="flex items-center gap-3">
                <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-verified-soft text-verified ring-1 ring-verified/20">
                  <CheckCircle2 className="h-4.5 w-4.5" aria-hidden />
                </span>
                <h2 className="font-display text-xl font-semibold text-ink">With MjengoOS</h2>
              </div>
              <ul className="mt-6 space-y-4">
                {role.gains.map((gain) => (
                  <li key={gain} className="flex items-start gap-3">
                    <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-verified" aria-hidden />
                    <span className="text-[15px] leading-relaxed text-ink-soft">{gain}</span>
                  </li>
                ))}
              </ul>
            </article>
          </Reveal>
        </div>
      </PageSection>

      {/* Your surface — the role's dashboard preview */}
      <PageSection tone="warm" ariaLabel="Your surface — dashboard preview">
        <SectionHeading
          eyebrow="Your surface"
          title={`The ${role.name} view, every morning.`}
          description="The same record the whole build runs on, shaped for your seat — these are the cards this role opens first."
        />
        <div className="mt-10">
          <RoleSurface role={role} />
        </div>
      </PageSection>

      {/* How it fits — description + modules */}
      <PageSection tone="paper" ariaLabel="How MjengoOS fits this role">
        <div className="grid gap-10 lg:grid-cols-[1.2fr_1fr] lg:gap-16">
          <div>
            <SectionHeading
              eyebrow="How it fits"
              title="Your work, on the record."
              description={role.description}
            />
            <Reveal delay={140} className="mt-7">
              <SiteLink
                href="/platform"
                className="inline-flex min-h-11 items-center gap-1.5 text-[14.5px] font-semibold text-forest-700 underline decoration-forest-300 underline-offset-4 transition-colors hover:text-forest-800"
              >
                See all ten modules on the platform
                <ArrowRight className="h-4 w-4" aria-hidden />
              </SiteLink>
            </Reveal>
          </div>

          <Reveal delay={120}>
            <div className="rounded-xl border border-ink/10 bg-white p-6 sm:p-7">
              <p className="text-[10.5px] font-semibold uppercase tracking-[0.16em] text-ink-mute">
                Modules scoped to this role
              </p>
              <div className="mt-4 flex flex-wrap gap-2">
                {role.modules.map((m) => (
                  <span
                    key={m}
                    className="rounded-md border border-ink/10 bg-paper px-2.5 py-1.5 text-[12.5px] font-medium text-ink-soft"
                  >
                    {m}
                  </span>
                ))}
              </div>
              <p className="mt-5 border-t border-ink/10 pt-4 text-[12.5px] leading-relaxed text-ink-mute">
                Permissions follow the role server-side — the surface is what changes, never
                the integrity of the record beneath it.
              </p>
            </div>
          </Reveal>
        </div>
      </PageSection>

      {/* CTA + other roles */}
      <PageSection tone="dark" className="relative overflow-hidden" ariaLabel="Get started">
        <div className="absolute inset-0 bg-survey-grid-dark" aria-hidden />
        <div className="absolute inset-0 opacity-40" aria-hidden>
          <MapVisual dark className="h-full w-full" />
        </div>

        <div className="relative mx-auto max-w-2xl text-center">
          <Reveal>
            <h2 className="font-display text-3xl font-semibold leading-[1.08] tracking-tight text-forest-50 sm:text-4xl">
              Start building on the record.
            </h2>
          </Reveal>
          <Reveal delay={90}>
            <p className="mx-auto mt-4 max-w-xl text-[16px] leading-relaxed text-forest-300/90">
              Get started as a {role.name.toLowerCase()} — or talk to us first about how it fits
              the way you already work.
            </p>
          </Reveal>
          <Reveal delay={180} className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Button href="/signup" size="lg">
              Get started as {role.name}
              <ArrowRight className="h-4 w-4" aria-hidden />
            </Button>
            <Button href="/contact" size="lg" variant="outline-dark">
              Talk to us
            </Button>
          </Reveal>
        </div>

        {/* Other roles */}
        <Reveal delay={240}>
          <div className="relative mx-auto mt-14 max-w-3xl border-t border-forest-700 pt-8 text-center">
            <p className="font-mono text-[10.5px] uppercase tracking-[0.2em] text-forest-300/60">
              Other roles on the build
            </p>
            <ul className="mt-4 flex flex-wrap justify-center gap-2.5">
              {otherRoles.map((r) => (
                <li key={r.slug}>
                  <SiteLink
                    href={`/solutions/${r.slug}`}
                    className="inline-flex min-h-11 items-center rounded-lg border border-forest-700 bg-forest-950/60 px-4 text-[13.5px] font-medium text-forest-100 transition-colors duration-150 hover:border-earth-400/50 hover:text-earth-300"
                  >
                    {r.name}
                  </SiteLink>
                </li>
              ))}
            </ul>
            <p className="mt-6 text-[12.5px] text-forest-300/70">
              Or see the{" "}
              <SiteLink
                href="/solutions"
                className="font-medium text-earth-300 underline decoration-earth-400/40 underline-offset-4 hover:text-earth-400"
              >
                full list of solutions
              </SiteLink>
              .
            </p>
          </div>
        </Reveal>
      </PageSection>
    </>
  );
}

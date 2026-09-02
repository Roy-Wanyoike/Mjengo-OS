import type { Metadata } from "next";
import { MapPin, Clock } from "lucide-react";
import { PageHero } from "@/components/page-hero";
import { Reveal } from "@/components/reveal";
import { ProjectTimeline } from "./components/project-timeline";
import { MonitoringDashboard } from "./components/monitoring-dashboard";
import { HandoverArtifacts } from "./components/handover-artifacts";
import { RoleSurfaces } from "./components/role-surfaces";
import { ProjectsCtaBand } from "./components/cta-band";
import { asset } from "@/lib/utils";

export const metadata: Metadata = {
  title: "Projects",
  description:
    "From groundbreaking to handover — tracked. The full project lifecycle on one timeline, remote client monitoring with photo-verified progress, and a complete project record at handover: photo timeline, financial ledger, decisions log and verification passport.",
  alternates: { canonical: "/projects" },
};

/**
 * /projects — project lifecycle & monitoring: the full timeline, the
 * remote client dashboard, the handover artifacts, the role surfaces
 * link band and the CTA.
 */
export default function ProjectsPage() {
  return (
    <>
      <PageHero
        eyebrow="Projects"
        title="From groundbreaking to handover — tracked."
        description="One timeline from land to handover, a client view that travels, and a project record that answers questions years after the last fundi leaves site. Every stage anchored to evidence."
      >
        <Reveal delay={200}>
          <figure className="relative overflow-hidden rounded-xl border border-ink/10 shadow-[0_24px_64px_-28px_rgb(23_25_24/0.45)]">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={asset("/images/aerial.jpg")}
              alt="Aerial view of a residential construction site and its surroundings"
              className="aspect-[21/9] w-full object-cover"
              loading="lazy"
            />
            <div className="absolute inset-x-0 bottom-0 flex flex-wrap items-center justify-between gap-2 bg-gradient-to-t from-ink/70 to-transparent px-4 pb-3 pt-10">
              <span className="text-[11.5px] font-medium text-white">
                The build from above — Karen Residence, example project
              </span>
              <span className="flex items-center gap-2">
                <span className="flex items-center gap-1.5 rounded-md bg-ink/75 px-2.5 py-1 font-mono text-[10.5px] text-white backdrop-blur-sm">
                  <MapPin className="h-3 w-3 text-earth-400" aria-hidden /> -1.3190, 36.7765
                </span>
                <span className="flex items-center gap-1.5 rounded-md bg-ink/75 px-2.5 py-1 font-mono text-[10.5px] text-white backdrop-blur-sm">
                  <Clock className="h-3 w-3 text-earth-400" aria-hidden /> Day 47
                </span>
              </span>
            </div>
          </figure>
        </Reveal>
      </PageHero>

      <ProjectTimeline />
      <MonitoringDashboard />
      <HandoverArtifacts />
      <RoleSurfaces />
      <ProjectsCtaBand />
    </>
  );
}

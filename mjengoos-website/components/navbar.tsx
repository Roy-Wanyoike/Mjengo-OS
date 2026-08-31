"use client";

import { useEffect, useRef, useState } from "react";
import { Menu, X, ArrowRight } from "lucide-react";
import { Logo } from "@/components/logo";
import { NavLink, SiteLink } from "@/components/site-link";
import { AppLink } from "@/components/app-link";
import { NAV_ITEMS } from "@/data/nav";
import { cn } from "@/lib/utils";
import { track } from "@/lib/analytics";

export function Navbar() {
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // Close the mobile menu on Escape and lock body scroll while open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open]);

  return (
    <header
      className={cn(
        "fixed inset-x-0 top-0 z-50 transition-all duration-300",
        scrolled
          ? "border-b border-ink/10 bg-paper/90 shadow-[0_1px_12px_rgb(23_25_24/0.06)] backdrop-blur-md"
          : "border-b border-transparent bg-transparent",
      )}
    >
      <nav aria-label="Main navigation" className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6 lg:px-8">
        <SiteLink
          href="/"
          aria-label="MjengoOS home"
          className="rounded-md focus-visible:outline-2 focus-visible:outline-offset-4"
        >
          <Logo />
        </SiteLink>

        {/* Desktop nav */}
        <div className="hidden items-center gap-7 lg:flex">
          {NAV_ITEMS.map((item) => (
            <NavLink key={item.href} href={item.href} className="text-[14.5px]">
              {item.label}
            </NavLink>
          ))}
        </div>

        <div className="hidden items-center gap-3 lg:flex">
          <AppLink
            className="text-[14.5px] font-medium text-ink-mute transition-colors hover:text-ink"
            trackEvent="signin_clicked"
          >
            Sign in
          </AppLink>
          <SiteLink
            href="/signup"
            onClick={() => track("signup_started", { source: "navbar" })}
            className="inline-flex h-10 items-center gap-1.5 rounded-md bg-earth-500 px-4 text-sm font-medium text-ink shadow-[0_1px_2px_rgb(23_25_24/0.2),0_8px_24px_-12px_rgb(217_145_60/0.6)] transition-all hover:bg-earth-400 active:translate-y-px"
          >
            Get Started
            <ArrowRight className="h-4 w-4" aria-hidden />
          </SiteLink>
        </div>

        {/* Mobile toggle */}
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls="mobile-menu"
          aria-label={open ? "Close menu" : "Open menu"}
          className="inline-flex h-11 w-11 items-center justify-center rounded-md text-ink hover:bg-ink/5 lg:hidden"
        >
          {open ? <X className="h-6 w-6" aria-hidden /> : <Menu className="h-6 w-6" aria-hidden />}
        </button>
      </nav>

      {/* Mobile menu */}
      <div
        id="mobile-menu"
        ref={menuRef}
        className={cn(
          "overflow-hidden border-t border-ink/10 bg-paper transition-[max-height,opacity] duration-300 ease-out lg:hidden",
          open ? "max-h-[calc(100vh-4rem)] opacity-100" : "max-h-0 opacity-0",
        )}
      >
        <div className="space-y-1 px-4 py-4">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.href}
              href={item.href}
              className="block rounded-md px-3 py-3 text-base hover:bg-ink/5"
              onClick={() => setOpen(false)}
            >
              {item.label}
            </NavLink>
          ))}
          <div className="mt-3 space-y-2 border-t border-ink/10 pt-4">
            <AppLink
              className="block rounded-md px-3 py-3 text-base font-medium text-ink-mute hover:bg-ink/5"
              trackEvent="signin_clicked"
            >
              Sign in
            </AppLink>
            <SiteLink
              href="/signup"
              onClick={() => {
                track("signup_started", { source: "mobile_nav" });
                setOpen(false);
              }}
              className="flex h-12 items-center justify-center gap-2 rounded-md bg-earth-500 text-base font-medium text-ink hover:bg-earth-400"
            >
              Get Started
              <ArrowRight className="h-4 w-4" aria-hidden />
            </SiteLink>
          </div>
        </div>
      </div>
    </header>
  );
}

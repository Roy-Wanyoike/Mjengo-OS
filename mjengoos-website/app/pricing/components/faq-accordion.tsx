"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import type { FaqItem } from "@/types";
import { cn } from "@/lib/utils";

/**
 * Pricing FAQ accordion (§54). Accessible disclosure list:
 *  - each header is a real <button> with aria-expanded / aria-controls,
 *  - each panel is a labelled region (aria-labelledby),
 *  - height animates with the grid-template-rows 0fr→1fr technique —
 *    no JS measuring, and the global reduced-motion kill-switch makes
 *    it instant for users who prefer that,
 *  - collapsed panels are inert, so they stay out of the tab order and
 *    the accessibility tree until opened.
 */
export function FaqAccordion({ items }: { items: FaqItem[] }) {
  const [open, setOpen] = useState<number | null>(0);

  return (
    <div className="divide-y divide-ink/10 overflow-hidden rounded-xl border border-ink/10 bg-white">
      {items.map((item, index) => {
        const isOpen = open === index;
        const buttonId = `faq-btn-${index}`;
        const panelId = `faq-panel-${index}`;
        return (
          <div key={item.question}>
            <h3>
              <button
                type="button"
                id={buttonId}
                aria-expanded={isOpen}
                aria-controls={panelId}
                onClick={() => setOpen(isOpen ? null : index)}
                className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left transition-colors hover:bg-paper/70"
              >
                <span className="text-[15px] font-semibold text-ink">{item.question}</span>
                <ChevronDown
                  className={cn(
                    "h-4 w-4 shrink-0 text-ink-mute transition-transform duration-300",
                    isOpen && "rotate-180",
                  )}
                  aria-hidden
                />
              </button>
            </h3>
            <div
              id={panelId}
              role="region"
              aria-labelledby={buttonId}
              className="grid transition-[grid-template-rows] duration-300 ease-out"
              style={{ gridTemplateRows: isOpen ? "1fr" : "0fr" }}
            >
              <div className="overflow-hidden" inert={!isOpen}>
                <p className="px-5 pb-5 text-[14.5px] leading-relaxed text-ink-soft">{item.answer}</p>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

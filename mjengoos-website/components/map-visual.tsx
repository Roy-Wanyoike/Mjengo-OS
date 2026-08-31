import { cn } from "@/lib/utils";

/**
 * Subtle topographic map motif — contour lines, a survey grid and location
 * pins. Used as section background texture, never as the main content.
 */
export function MapVisual({ className, dark = false }: { className?: string; dark?: boolean }) {
  const stroke = dark ? "#9DBDAF" : "#123C32";
  const opacity = dark ? 0.16 : 0.12;
  return (
    <svg
      viewBox="0 0 600 400"
      aria-hidden
      className={cn("pointer-events-none select-none", className)}
      preserveAspectRatio="xMidYMid slice"
    >
      <g stroke={stroke} strokeOpacity={opacity} fill="none" strokeLinecap="round">
        {/* Contour cluster — hill top-left */}
        <path d="M40 150 C 80 90, 180 70, 240 110 C 300 150, 280 210, 220 230 C 160 250, 80 230, 50 190 C 35 170, 35 160, 40 150 Z" strokeWidth="1.4" />
        <path d="M70 160 C 100 115, 175 100, 225 130 C 270 158, 255 200, 205 215 C 155 230, 95 215, 72 185 C 62 172, 64 165, 70 160 Z" strokeWidth="1.2" />
        <path d="M100 168 C 122 135, 168 125, 205 148 C 240 168, 228 195, 192 205 C 156 215, 115 202, 100 182 C 94 174, 95 170, 100 168 Z" strokeWidth="1" />
        <path d="M128 176 C 143 153, 172 148, 196 163 C 218 176, 212 192, 188 198 C 164 204, 136 195, 128 184 C 124 179, 125 177, 128 176 Z" strokeWidth="0.9" />

        {/* Contour cluster — ridge right */}
        <path d="M400 60 C 460 40, 540 70, 570 130 C 595 185, 560 240, 500 250 C 440 260, 395 225, 385 170 C 378 128, 380 75, 400 60 Z" strokeWidth="1.4" />
        <path d="M420 85 C 470 70, 535 95, 558 140 C 578 182, 550 220, 502 228 C 455 236, 418 208, 410 165 C 404 132, 405 92, 420 85 Z" strokeWidth="1.2" />
        <path d="M440 108 C 478 97, 528 118, 545 152 C 560 183, 540 208, 504 213 C 468 218, 440 197, 435 165 C 432 145, 432 113, 440 108 Z" strokeWidth="1" />

        {/* Valley bottom-left */}
        <path d="M60 320 C 130 290, 200 300, 260 330 C 320 360, 380 365, 440 345" strokeWidth="1.2" />
        <path d="M50 350 C 130 322, 210 332, 270 360 C 330 385, 400 390, 460 372" strokeWidth="1" />

        {/* Water feature bottom-right */}
        <path d="M470 300 C 510 290, 550 300, 565 325 C 575 345, 555 365, 525 362 C 495 359, 470 340, 468 320 C 467 308, 468 302, 470 300 Z" strokeWidth="1.2" strokeDasharray="4 3" />
      </g>

      {/* Survey pins */}
      <g fill={dark ? "#D9913C" : "#C68A2B"} fillOpacity={dark ? 0.55 : 0.5}>
        <circle cx="240" cy="110" r="3.4" />
        <circle cx="500" cy="250" r="3.4" />
        <circle cx="105" cy="255" r="2.6" />
      </g>
      <g stroke={dark ? "#D9913C" : "#C68A2B"} strokeOpacity={dark ? 0.4 : 0.35} strokeWidth="1">
        <path d="M240 110 v-22 M240 88 l-5 7 M240 88 l5 7" />
        <path d="M500 250 v-22 M500 228 l-5 7 M500 228 l5 7" />
      </g>

      {/* Parcel boundary lines */}
      <g stroke={dark ? "#F3F2EE" : "#171918"} strokeOpacity={dark ? 0.1 : 0.08} strokeWidth="1" strokeDasharray="6 4">
        <path d="M0 210 L600 190" />
        <path d="M150 400 L320 0" />
        <path d="M600 300 L360 400" />
      </g>
    </svg>
  );
}

/** Compact inline map with a single highlighted parcel + pin (for cards). */
export function ParcelMap({ className, pinLabel }: { className?: string; pinLabel?: string }) {
  return (
    <svg viewBox="0 0 220 140" aria-hidden className={cn("select-none", className)}>
      <rect width="220" height="140" rx="8" className="fill-forest-50" />
      <g stroke="#123C32" strokeOpacity="0.14" strokeWidth="1">
        <path d="M0 35 h220 M0 70 h220 M0 105 h220 M55 0 v140 M110 0 v140 M165 0 v140" />
      </g>
      <g stroke="#123C32" strokeOpacity="0.35" strokeWidth="1.4" fill="none" strokeDasharray="5 3">
        <path d="M38 26 h70 v58 h-70 Z" />
      </g>
      <path d="M73 48 c0-6 4.5-10 10-10 s10 4 10 10 c0 7-10 15-10 15 s-10-8-10-15 Z" className="fill-earth-500" />
      <circle cx="83" cy="48" r="3" className="fill-ink" fillOpacity="0.4" />
      {pinLabel && (
        <text x="118" y="42" className="fill-forest-800" fontSize="9" fontFamily="ui-monospace, monospace">
          {pinLabel}
        </text>
      )}
    </svg>
  );
}

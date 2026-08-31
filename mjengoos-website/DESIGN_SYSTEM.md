# MjengoOS Website — Design System

The visual identity: **earth + concrete + infrastructure + modern software.**
It deliberately echoes the product (stone paper, forest-dark surfaces, amber
data accents) so the marketing site and the application feel like one product.

Reference disciplines, not copies: editorial layouts, strong typography,
generous whitespace, technical/infrastructure feeling, subtle maps, restrained
color.

---

## 1. Color tokens

Defined as Tailwind 4 `@theme` scales in `styles/globals.css`.

| Token | Value | Role |
|---|---|---|
| `forest-800` | `#123C32` | **Primary brand** — dark surfaces, forest sections, logo |
| `forest-900` / `950` | `#0b2a23` / `#06231c` | Deep section backgrounds (ecosystem, footer, CTA) |
| `forest-600/500` | `#2c6b58` / `#3e836e` | Progress bars, secondary accents on dark |
| `forest-300` | `#9dbdaf` | Muted text on dark surfaces |
| `forest-100/50` | `#dce7e0` / `#eef3f0` | Chips, soft backgrounds |
| `earth-500` | `#D9913C` | **Accent — used sparingly**: primary CTAs, key data, survey pins |
| `earth-600/700` | `#c68a2b` / `#a5681f` | Accent text, hover states |
| `earth-300/100/50` | lighter | Soft accent tints |
| `paper` | `#F3F2EE` | Page background (warm concrete) |
| `paper-warm` | `#edebe4` | Alternate section background |
| `ink` | `#171918` | Primary text |
| `ink-soft` / `ink-mute` / `ink-faint` | `#3a3d3b` / `#6b706d` / `#9a9e9b` | Text hierarchy |
| `verified` | `#2f7d52` | Positive verification status |
| `caution` | `#c68a2b` | Review-required status |
| `alert` | `#b94a48` | Alerts (never used for accusations) |

**Rules**

- Earth amber is the *only* accent. It appears on CTAs and key data — never as
  large fills or gradients.
- No purple, no blue gradients, no glassmorphism, no glow.
- Dark sections are forest, not black; hairline borders (`border-ink/10`,
  `border-hairline-dark`) instead of heavy shadows.

## 2. Typography

| Role | Font | Usage |
|---|---|---|
| Body | **Geist** (`next/font`) | Everything except display headings |
| Display | **Space Grotesk** (`next/font`) | Headlines, mockup numbers, `.font-display` |

Scale (mobile → desktop):

- H1 hero: `text-[42px] sm:text-6xl` (2xl–6xl), `font-display font-bold`
- H2 section: `text-3xl sm:text-4xl font-semibold`, tracking-tight
- H3 card: `text-xl` or `text-[17px] font-semibold`
- Body: `text-[15px]` / `text-base` leading-relaxed
- Micro-labels: `text-[10.5px] uppercase tracking-[0.14em]` (mono-feel metadata)
- Monospace moments: `font-mono` for coordinates, codes, chain formulas

## 3. Spacing & layout

- `Container`: `max-w-6xl` + `px-4 sm:px-6 lg:px-8`
- `WideContainer`: `max-w-7xl` (reserved for dense product mockups)
- Section rhythm: `py-20 lg:py-28` (homepage) / `py-16 sm:py-20` (subpages)
- Grid gap: `gap-12 lg:gap-16` (two-col feature rows), `gap-5/6` (cards)
- Card padding: `p-5/p-6`, mockup cards `px-4/5`

## 4. Components

| Component | File | Notes |
|---|---|---|
| `Button` / `ActionButton` | `components/button.tsx` | Link-based CTAs. Variants: primary (earth), secondary (forest), ghost, dark, outline-dark. Sizes sm/md/lg, min-h-11 touch targets |
| `Badge` / `VerificationBadge` / `DemoChip` | `components/badge.tsx` | Tones map to verification language. `DemoChip` = the honesty label for all demo UI |
| `Container` | `components/container.tsx` | Page rhythm |
| `SectionHeading` | `components/section-heading.tsx` | Eyebrow (amber, tracked) + display title + description; `dark` variant |
| `PageHero` / `PageSection` | `components/page-hero.tsx` | Subpage scaffolding; tones paper/warm/forest/dark |
| `Reveal` | `components/reveal.tsx` | IntersectionObserver scroll-reveal; includes `min-w-0` (grid-overflow safety) |
| `Counter` | `components/counter.tsx` | rAF count-up on scroll into view |
| `Logo` / `LogoMark` | `components/logo.tsx` | Parcel-boundary + M-roofline + survey-pin mark |
| `Navbar` / `Footer` | `components/navbar.tsx` etc. | Sticky translucent navbar; mobile menu (Escape + scroll-lock); 4-column footer |
| `SiteLink` / `NavLink` / `AppLink` | `components/site-link.tsx` etc. | Gateway-port-preserving internal links; app-origin links |
| `MapVisual` / `ParcelMap` | `components/map-visual.tsx` | Contour-line + survey-grid SVG motifs (decorative, aria-hidden) |
| `DashboardMockup` | `components/product/dashboard-mockup.tsx` | Hero product composition with animated counters |
| `ContactForm` | `components/contact-form.tsx` | Full-state form (idle/submitting/success/error + field errors + retry) |

## 5. Card & surface style

- White cards on paper: `rounded-xl border border-ink/10 bg-white` + soft
  elevation `shadow-[0_24px_64px_-28px_rgb(23_25_24/0.3)]`
- Highlighted cards: `border-earth-300/50 bg-earth-50` (milestone-style)
- Dark panels: `bg-forest-900/950` + `border-forest-700/800`
- Status tint cards: `verified-soft` / `caution-soft` / `alert-soft`
- Corners: `rounded-md` (small) / `rounded-lg` (inner) / `rounded-xl` (cards) —
  never fully-round blobs

## 6. Map & evidence motifs

- `bg-survey-grid` / `bg-survey-grid-dark`: 56px grid overlays for dark bands
- `MapVisual`: contour clusters, dashed parcel lines, amber survey pins —
  absolute, `opacity-40–60`, `aria-hidden`
- Photo overlays: GPS + timestamp chips (`bg-ink/70 font-mono text-[10.5px]`)
- Coordinates in copy: real Nairobi coords (`-1.3190, 36.7765`)

## 7. Animation system

Two systems, both reduced-motion safe:

1. **Scroll reveal** (`Reveal`): `[data-reveal]` CSS (opacity + 16px rise,
   `--ease-expo`), triggered by IntersectionObserver once, `--reveal-delay`
   stagger. `prefers-reduced-motion` → content visible immediately.
2. **CSS keyframes** (`fadeSlide`): mockup card entrances via inline
   `animation` — killed globally by the reduced-motion rule.

Counters (hero dashboard, remote monitoring, wallet) animate with rAF and
ease-out cubic; reduced-motion renders final values instantly.

Global reduced-motion kill-switch lives in `styles/globals.css`.

## 8. Responsive behavior

Breakpoints follow Tailwind defaults. Layout intent:

- **Mobile (375–430)**: single column; grids collapse; tables live in
  `overflow-x-auto scroll-thin` scroll containers; role tabs wrap; mobile
  menu (not mega-menu)
- **Tablet (768)**: two-col feature rows begin (`sm:grid-cols-2`)
- **Laptop (1024+)**: full two-col layouts (`lg:grid-cols-[1fr_1.1fr]`),
  desktop navbar, hero grid

Grid-overflow safety: every grid item that can contain wide content is
`min-w-0` (enforced in `Reveal`), and the `Badge` component is `relative` so
its `sr-only` label can never escape a scroll container. **All pages measure
`scrollWidth == viewport` at 390px.**

## 9. Accessibility

- Semantic landmarks (`header nav main footer section[aria-label]`)
- Skip link (`sr-only focus:not-sr-only`)
- Keyboard: visible `:focus-visible` outlines (earth-600), Escape closes the
  mobile menu, body scroll-lock while open
- Role tablist in the role switcher (`role=tab` / `aria-selected` /
  `aria-controls`)
- `aria-label`s on every icon-only control; decorative SVGs `aria-hidden`
- Alt text on all real photos; mockup composites carry one descriptive
  `aria-label` (role="img")
- Tables: real `<th scope=col>` headers

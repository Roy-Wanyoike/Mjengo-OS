import type { Metadata, Viewport } from "next";
import { Geist, Space_Grotesk } from "next/font/google";
import "@/styles/globals.css";
import { Navbar } from "@/components/navbar";
import { Footer } from "@/components/footer";
import { PageAnalytics } from "@/components/page-analytics";
import { SITE } from "@/lib/site";

const geist = Geist({
  variable: "--font-geist",
  subsets: ["latin"],
});

const grotesk = Space_Grotesk({
  variable: "--font-grotesk",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

export const metadata: Metadata = {
  metadataBase: new URL(SITE.url),
  title: {
    default: "MjengoOS — Build with evidence.",
    template: "%s — MjengoOS",
  },
  description: SITE.description,
  applicationName: "MjengoOS",
  keywords: [
    "construction management Kenya",
    "construction project management",
    "construction software Africa",
    "project monitoring",
    "land verification Kenya",
    "construction procurement",
    "construction materials prices",
    "construction project tracking",
    "contractor management",
  ],
  openGraph: {
    type: "website",
    siteName: "MjengoOS",
    title: "MjengoOS — Build with evidence.",
    description: SITE.description,
    url: SITE.url,
    images: [{ url: "/images/og.png", width: 1200, height: 630, alt: "MjengoOS — Build with evidence." }],
  },
  twitter: {
    card: "summary_large_image",
    title: "MjengoOS — Build with evidence.",
    description: SITE.description,
    images: ["/images/og.png"],
  },
  robots: { index: true, follow: true },
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "48x48" },
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
    ],
    apple: [{ url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }],
  },
};

export const viewport: Viewport = {
  themeColor: "#123C32",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${geist.variable} ${grotesk.variable} bg-paper font-sans text-ink antialiased`}>
        {/* Skip link for keyboard users */}
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[60] focus:rounded-md focus:bg-forest-800 focus:px-4 focus:py-2.5 focus:text-sm focus:font-medium focus:text-forest-50"
        >
          Skip to content
        </a>
        <Navbar />
        <main id="main" className="pt-16">
          {children}
        </main>
        <Footer />
        <PageAnalytics />
      </body>
    </html>
  );
}

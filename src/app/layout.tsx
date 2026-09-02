import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/frontend/ui/sonner";
import { AuthSessionProvider } from "@/frontend/auth/session-provider";
import { I18nProvider } from "@/frontend/i18n/provider";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "MjengoOS — Construction Site OS",
  description:
    "Offline-first construction site OS for Kenya. AI photo progress tracking, Swahili voice-to-invoice, anomaly detection, fundi attendance & M-Pesa-ready wage payments.",
  keywords: ["MjengoOS", "construction", "Kenya", "fundi", "offline-first", "AI", "site management"],
  manifest: "/manifest.webmanifest",
  icons: {
    apple: "/icons/apple-touch-icon.png",
  },
};

export const viewport: Viewport = {
  themeColor: "#1c1917",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        {/* i18n (W4-I18N · spec §62) — wraps the session provider so the login
            gate and every surface below it can use t(); locale persists via the
            SAME `mjengo-os-settings` store the Settings tab writes. */}
        <I18nProvider>
          <AuthSessionProvider>{children}</AuthSessionProvider>
        </I18nProvider>
        <Toaster richColors position="top-center" />
        {/* Service-worker registration (PWA). /api/* is never cached — see
            public/sw.js. Registered on window load so it never competes with
            first paint, and guarded so non-SW browsers skip it. */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "if('serviceWorker' in navigator){window.addEventListener('load',function(){navigator.serviceWorker.register('/sw.js').catch(function(e){console.warn('SW registration skipped:',e)})})}",
          }}
        />
      </body>
    </html>
  );
}

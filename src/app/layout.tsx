import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/sonner";
import { AuthSessionProvider } from "@/components/auth/session-provider";

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
        <AuthSessionProvider>{children}</AuthSessionProvider>
        <Toaster richColors position="top-center" />
      </body>
    </html>
  );
}

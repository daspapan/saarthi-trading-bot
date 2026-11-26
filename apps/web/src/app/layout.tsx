import type { Metadata, Viewport } from "next";
import "./globals.css";
import { AlertToaster } from "@/components/AlertToaster";
import { CommandPalette } from "@/components/CommandPalette";
import { LockGate } from "@/components/LockGate";
import { MobileNav } from "@/components/MobileNav";
import { PwaRegister } from "@/components/PwaRegister";
import { Nav } from "@/components/Nav";

export const metadata: Metadata = {
  title: "Saarthi",
  description: "Local AI trading demo. The AI is the analyst, never the trader. Testnet only.",
  applicationName: "Saarthi",
  appleWebApp: { capable: true, title: "Saarthi", statusBarStyle: "default" },
  icons: { icon: "/icon-192.png", apple: "/apple-touch-icon.png" },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f4f6f9" },
    { media: "(prefers-color-scheme: dark)", color: "#0b1220" },
  ],
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

// Applies the saved theme before the first paint (no light flash in dark mode).
const THEME_SCRIPT = `try{var t=localStorage.getItem("saarthi-theme");if(t==="dark"||t==="light")document.documentElement.dataset.theme=t}catch(e){}`;

// Rule 9: this banner is part of the root layout, so it is on every page.
const DISCLAIMER =
  "Testnet with virtual funds. Not financial advice. Testnet results do not predict real results.";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="min-h-screen pb-20 antialiased sm:pb-0">
        <div
          role="note"
          data-testid="disclaimer-banner"
          className="sticky top-0 z-50 border-b border-warn/40 bg-banner px-4 py-2 text-center text-sm font-bold text-banner-text"
        >
          {DISCLAIMER}
        </div>
        <Nav />
        <LockGate>
          {children}
          <AlertToaster />
          <CommandPalette />
          <MobileNav />
        </LockGate>
        <PwaRegister />
      </body>
    </html>
  );
}

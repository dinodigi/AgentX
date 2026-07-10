import type { ReactNode } from "react";
import { ClerkProvider } from "@clerk/nextjs";
import { Archivo, JetBrains_Mono } from "next/font/google";
import "./globals.css";

// Rebrand direction (Direction.dc.html): Archivo carries display + UI (one
// family, two weights/tracking), JetBrains Mono carries "technical truth" —
// ids, tool names, code, eyebrows, chips, CTAs. Both OFL.
const archivo = Archivo({
  subsets: ["latin"],
  variable: "--font-body",
  weight: ["400", "500", "600", "700"],
});
const mono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  weight: ["400", "500", "600"],
});

export const metadata = {
  title: "AgentX Admin",
  description: "Schema-driven admin",
};

/**
 * Clerk themed to the dark "signal on black" register so the sign-in page and
 * the admin's UserButton read as one system — not a white card on black.
 */
const clerkAppearance = {
  variables: {
    colorBackground: "#0D0F12",
    colorPrimary: "#43DE83",
    colorTextOnPrimaryBackground: "#0A0B0D",
    colorText: "#E7EAE8",
    colorTextSecondary: "#9BA3A0",
    colorInputBackground: "#14171B",
    colorInputText: "#E7EAE8",
    colorNeutral: "#E7EAE8",
    colorDanger: "#FF7B72",
    colorSuccess: "#43DE83",
    borderRadius: "0.5rem",
    fontFamily: "var(--font-body), ui-sans-serif, system-ui, sans-serif",
    fontFamilyButtons: "var(--font-mono), ui-monospace, monospace",
  },
  elements: {
    card: "border border-[rgba(255,255,255,0.08)] shadow-none",
    headerTitle: "tracking-tight",
    socialButtonsBlockButton: "border border-[rgba(255,255,255,0.12)]",
    formFieldInput: "border border-[rgba(255,255,255,0.12)]",
  },
} as const;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <ClerkProvider appearance={clerkAppearance}>
      <html lang="en" className={`${archivo.variable} ${mono.variable}`}>
        <body>{children}</body>
      </html>
    </ClerkProvider>
  );
}

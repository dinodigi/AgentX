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

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <ClerkProvider>
      <html lang="en" className={`${archivo.variable} ${mono.variable}`}>
        <body>{children}</body>
      </html>
    </ClerkProvider>
  );
}

import type { ReactNode } from "react";
import { ClerkProvider } from "@clerk/nextjs";
import { Bricolage_Grotesque, Schibsted_Grotesk, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";

const display = Bricolage_Grotesque({
  subsets: ["latin"],
  variable: "--font-display",
  weight: ["400", "500", "600", "700"],
});
const body = Schibsted_Grotesk({
  subsets: ["latin"],
  variable: "--font-body",
  weight: ["400", "500", "600"],
});
const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  weight: ["400", "500"],
});

export const metadata = {
  title: "AgentX Admin",
  description: "Schema-driven admin",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <ClerkProvider>
      <html lang="en" className={`${display.variable} ${body.variable} ${mono.variable}`}>
        <body>{children}</body>
      </html>
    </ClerkProvider>
  );
}

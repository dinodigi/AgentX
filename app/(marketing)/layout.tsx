import type { ReactNode } from "react";
import { Nav } from "@/components/marketing/Nav";
import { Footer } from "@/components/marketing/Footer";

/**
 * Marketing shell (rebrand direction). Always the dark register — the .mkt class
 * scopes link-hover green + CTA styles. Nav sticky on top, Footer below.
 */
export default function MarketingLayout({ children }: { children: ReactNode }) {
  return (
    <div
      className="mkt min-h-screen"
      style={{ background: "#0A0B0D", color: "#E7EAE8", fontFamily: "var(--font-sans)" }}
    >
      <Nav />
      {children}
      <Footer />
    </div>
  );
}

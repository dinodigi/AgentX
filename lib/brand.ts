/**
 * Brand containment (Direction.dc.html): a client's --brand color appears only
 * as a FILL; text/icons sitting ON that fill use --brand-ink, computed here so
 * an arbitrary brand — from near-white to near-black — always stays legible.
 *
 * Pure + isomorphic (no DOM) — call it server-side wherever --brand is injected
 * and set --brand-ink in the same style object.
 */

/** WCAG relative luminance of a #rgb / #rrggbb color (0 = black, 1 = white). */
function luminance(hex: string): number {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return 1; // unparseable → treat as light so ink defaults dark-safe
  let h = m[1];
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h, 16);
  const chan = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * chan[0] + 0.7152 * chan[1] + 0.0722 * chan[2];
}

/**
 * Near-black or near-white ink for text on a brand fill. Threshold 0.4 puts the
 * flip where it reads best: a bright brand (the green #43de83) gets dark ink, a
 * saturated mid/dark brand (indigo #4f46e5) gets white.
 */
export function brandInk(brandHex: string): string {
  return luminance(brandHex) > 0.4 ? "#0a0b0d" : "#ffffff";
}

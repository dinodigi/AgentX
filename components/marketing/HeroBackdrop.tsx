/**
 * Layered ambient hero background: a drifting hairline grid, a slow breathing
 * green aura, and a live "agent mesh" — nodes (agents/backends) linked by
 * flowing connection lines. Deterministic coordinates (no random → no hydration
 * mismatch). Pure CSS/SVG animation; respects reduced-motion via globals.
 */
const NODES: [number, number][] = [
  [90, 120], [230, 70], [370, 160], [520, 90], [660, 190],
  [150, 300], [320, 360], [470, 300], [620, 380], [740, 280],
];
const LINKS: [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [2, 6], [3, 7], [4, 9], [6, 7], [7, 8], [8, 9], [5, 6],
];

export function HeroBackdrop({ align = "right" }: { align?: "right" | "center" }) {
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      <div className="grid-backdrop absolute inset-0 opacity-70" />
      <div
        className="aura absolute"
        style={{
          top: "-10%",
          [align === "right" ? "right" : "left"]: align === "center" ? "20%" : "-5%",
          width: "60%",
          height: "80%",
          background: "radial-gradient(closest-side, rgba(67,222,131,0.14), transparent 72%)",
          filter: "blur(20px)",
        }}
      />
      <svg
        className="absolute inset-0 h-full w-full opacity-[0.55]"
        viewBox="0 0 800 460"
        fill="none"
        preserveAspectRatio="xMidYMid slice"
      >
        {LINKS.map(([a, b], i) => (
          <line
            key={i}
            x1={NODES[a][0]}
            y1={NODES[a][1]}
            x2={NODES[b][0]}
            y2={NODES[b][1]}
            stroke="rgba(67,222,131,0.22)"
            strokeWidth="1"
            strokeDasharray="4 10"
            style={{ animation: `dash-flow ${9 + (i % 5)}s linear infinite` }}
          />
        ))}
        {NODES.map(([x, y], i) => (
          <circle
            key={i}
            cx={x}
            cy={y}
            r={2.4}
            fill={i % 3 === 0 ? "#43DE83" : "rgba(231,234,232,0.5)"}
            style={{ animation: `node-pulse ${5 + (i % 4)}s ease-in-out ${i * 0.4}s infinite` }}
          />
        ))}
      </svg>
    </div>
  );
}

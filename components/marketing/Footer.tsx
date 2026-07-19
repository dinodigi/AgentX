import Link from "next/link";
import { C } from "./atoms";

/** Marketing footer (Footer.dc.html): brand blurb + 4 link columns + status bar. */
const COLS: { head: string; links: [string, string, boolean?][] }[] = [
  {
    head: "Products",
    links: [
      ["AgentX", "/product"],
      ["Hostile Agent", "/hostile-agent", true],
      ["All products", "/products"],
    ],
  },
  {
    head: "AgentX",
    links: [
      ["Data modeling", "/product/capabilities#data-modeling"],
      ["Delivery API", "/product/capabilities#delivery-api"],
      ["Authorization", "/product/capabilities#authorization"],
      ["Automation", "/product/capabilities#automation"],
      ["Payments", "/product/capabilities#payments"],
      ["Compute", "/product/capabilities#compute"],
      ["Realtime", "/product/capabilities#realtime"],
      ["Trust", "/product/capabilities#trust"],
    ],
  },
  {
    head: "Solutions",
    links: [
      ["Agencies", "/solutions#agencies"],
      ["AI builders", "/solutions#ai-builders"],
      ["Content sites", "/solutions#content-sites"],
      ["Membership", "/solutions#membership"],
      ["Commerce", "/solutions#commerce"],
    ],
  },
  {
    head: "Company",
    links: [
      ["Developers", "/developers"],
      ["Pricing", "/pricing"],
      ["About", "/company"],
      ["Contact", "/company"],
    ],
  },
];

export function Footer() {
  return (
    <footer
      className="border-t px-8 pb-10 pt-16"
      style={{ borderColor: C.line, background: C.deep }}
    >
      <div className="mx-auto grid max-w-[1200px] gap-x-6 gap-y-10 [grid-template-columns:repeat(auto-fit,minmax(150px,1fr))]">
        <div className="flex flex-col gap-4">
          <Link href="/" className="flex items-center gap-2.5" style={{ color: C.ink }}>
            <span className="inline-block h-3.5 w-3.5 rounded-[2px]" style={{ background: C.accent }} />
            <span className="text-base font-semibold">Pluggie</span>
          </Link>
          <p className="m-0 max-w-[260px] text-[13px] leading-[1.6]" style={{ color: C.faint }}>
            Backend tools for the agent era. Built by Currents Studio.
          </p>
          <p className="m-0 font-mono text-[11px]" style={{ color: C.fainter }}>
            42 MCP tools · 458 smoke tests green
          </p>
        </div>
        {COLS.map((col) => (
          <div key={col.head} className="flex flex-col gap-3 text-[13.5px]">
            <span
              className="font-mono text-[10.5px] uppercase tracking-[0.1em]"
              style={{ color: C.faint }}
            >
              {col.head}
            </span>
            {col.links.map(([label, href, soon]) => (
              <Link key={label + href} href={href} className="flex items-center gap-2" style={{ color: C.mute }}>
                {label}
                {soon && (
                  <span
                    className="rounded-[3px] px-[5px] py-px font-mono text-[9px] tracking-[0.08em]"
                    style={{ color: C.faint, border: `1px solid rgba(255,255,255,0.14)` }}
                  >
                    SOON
                  </span>
                )}
              </Link>
            ))}
          </div>
        ))}
      </div>
      <div
        className="mx-auto mt-12 flex max-w-[1200px] flex-wrap items-center justify-between gap-3 border-t pt-6"
        style={{ borderColor: "rgba(255,255,255,0.06)" }}
      >
        <span className="text-xs" style={{ color: C.fainter }}>
          © 2026 Pluggie. AgentX and Hostile Agent are products of Pluggie.
        </span>
        <a
          href="https://stats.uptimerobot.com/YSeB4QyizR"
          target="_blank"
          rel="noopener noreferrer"
          className="font-mono text-[11px] transition-colors hover:opacity-80"
          style={{ color: C.fainter }}
        >
          system status ↗
        </a>
      </div>
    </footer>
  );
}

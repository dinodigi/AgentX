import { NextRequest } from "next/server";
import { getProjectRole } from "@/lib/access";
import { getCollection } from "@/lib/collections";
import { exportEntries } from "@/lib/export";

/** Entry data download for operators (same data as the export_entries tool). */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const projectId = url.searchParams.get("projectId") ?? "";
  const name = url.searchParams.get("collection") ?? "";
  const format = url.searchParams.get("format") === "csv" ? "csv" : "json";

  const role = await getProjectRole(projectId);
  if (role !== "operator") {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const collection = await getCollection(projectId, name);
  if (!collection) return Response.json({ error: "not found" }, { status: 404 });

  // #6: walk the keyset cursor so the download is the WHOLE collection, not the
  // first 5000 rows. Hard stop at 100 pages (500k rows) as a runaway guard —
  // beyond that, page the MCP tool instead.
  const MAX_PAGES = 100;
  let cursor: string | undefined;
  let pages = 0;
  const jsonRows: unknown[] = [];
  const csvParts: string[] = [];
  let clipped = false;
  for (;;) {
    const page = await exportEntries(collection, format, { cursor });
    if (format === "csv") {
      // Keep the header only on the first page.
      csvParts.push(pages === 0 ? page.csv! : page.csv!.split("\r\n").slice(1).join("\r\n"));
    } else {
      jsonRows.push(...(page.rows ?? []));
    }
    pages += 1;
    if (!page.nextCursor) break;
    if (pages >= MAX_PAGES) {
      clipped = true;
      break;
    }
    cursor = page.nextCursor;
  }
  const body =
    format === "csv"
      ? csvParts.filter((p) => p.length > 0).join("\r\n")
      : JSON.stringify({ truncated: clipped, rows: jsonRows }, null, 2);
  return new Response(body, {
    headers: {
      "content-type": format === "csv" ? "text/csv; charset=utf-8" : "application/json",
      "content-disposition": `attachment; filename="${name}-entries.${format}"`,
    },
  });
}

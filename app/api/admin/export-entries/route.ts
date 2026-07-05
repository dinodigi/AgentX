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

  const result = await exportEntries(collection, format);
  const body =
    format === "csv" ? result.csv! : JSON.stringify({ truncated: result.truncated, rows: result.rows }, null, 2);
  return new Response(body, {
    headers: {
      "content-type": format === "csv" ? "text/csv; charset=utf-8" : "application/json",
      "content-disposition": `attachment; filename="${name}-entries.${format}"`,
    },
  });
}

import { eq } from "drizzle-orm";
import { tenantDb } from "./data-plane";
import { entries, type Collection } from "@/db/schema";

/**
 * Entry export — the client's "can I get my data out?" answer. Raw stored
 * values (relations/assets stay ids so re-import mapping is possible), capped
 * at 5,000 rows with an explicit truncated flag. Schema portability lives in
 * the manifest; this is the data half.
 */

export const EXPORT_CAP = 5000;

export interface ExportedRow {
  id: string;
  data: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface ExportResult {
  format: "json" | "csv";
  rowCount: number;
  truncated: boolean;
  rows?: ExportedRow[];
  csv?: string;
}

export async function exportEntries(
  collection: Collection,
  format: "json" | "csv" = "json",
): Promise<ExportResult> {
  const raw = await (await tenantDb(collection.projectId))
    .select()
    .from(entries)
    .where(eq(entries.collectionId, collection.id))
    .limit(EXPORT_CAP + 1);

  const truncated = raw.length > EXPORT_CAP;
  const rows = raw.slice(0, EXPORT_CAP).map((r) => ({
    id: r.id,
    data: r.data,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }));

  if (format === "json") {
    return { format, rowCount: rows.length, truncated, rows };
  }

  const fieldNames = collection.fields.map((f) => f.name);
  const header = ["id", ...fieldNames, "createdAt", "updatedAt"];
  const lines = [header.map(csvCell).join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.id,
        ...fieldNames.map((f) => toCellValue(r.data[f])),
        r.createdAt,
        r.updatedAt,
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return { format, rowCount: rows.length, truncated, csv: lines.join("\r\n") };
}

function toCellValue(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function csvCell(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

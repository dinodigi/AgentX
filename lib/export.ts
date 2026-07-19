import { and, eq, sql } from "drizzle-orm";
import { tenantDb } from "./data-plane";
import { entries, type Collection } from "@/db/schema";
import { decodeCursor, makeCursor } from "./entries";

/**
 * Entry export — the client's "can I get my data out?" answer. Raw stored
 * values (relations/assets stay ids so re-import mapping is possible), paged
 * at 5,000 rows per call over the SAME keyset cursor contract query_entries
 * uses (#6 — a capped export with no cursor turned backup into sampling).
 * Rows order by (createdAt, id) — stable and index-served (A1 composite) — so
 * paging to nextCursor=null is a complete, exact export. Schema portability
 * lives in the manifest; this is the data half.
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
  /** Back-compat alias of hasMore (pre-cursor clients keyed on this). */
  truncated: boolean;
  hasMore: boolean;
  /** Keyset cursor — pass back as `cursor` for the next page; null = done. */
  nextCursor: string | null;
  rows?: ExportedRow[];
  csv?: string;
}

export async function exportEntries(
  collection: Collection,
  format: "json" | "csv" = "json",
  opts: { cursor?: string; limit?: number } = {},
): Promise<ExportResult> {
  const limit = Math.max(1, Math.min(opts.limit ?? EXPORT_CAP, EXPORT_CAP));
  const conditions = [eq(entries.collectionId, collection.id)];
  if (opts.cursor) {
    const after = decodeCursor(opts.cursor, "export_entries");
    conditions.push(
      sql`(${entries.createdAt}, ${entries.id}) > (${after.createdAt}::timestamptz, ${after.id}::uuid)`,
    );
  }

  // Microsecond ISO for the cursor (JS Dates lose Postgres micros) — same
  // technique as queryEntriesPage so pages never overlap or skip.
  const curT = sql<string>`to_char(${entries.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
  const raw = await (await tenantDb(collection.projectId))
    .select({ e: entries, curT })
    .from(entries)
    .where(and(...conditions))
    .orderBy(entries.createdAt, entries.id)
    .limit(limit + 1);

  const hasMore = raw.length > limit;
  const page = raw.slice(0, limit);
  const last = page[page.length - 1];
  const nextCursor = hasMore && last ? makeCursor(last.curT, last.e.id) : null;
  const rows = page.map(({ e: r }) => ({
    id: r.id,
    data: r.data,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }));

  if (format === "json") {
    return { format, rowCount: rows.length, truncated: hasMore, hasMore, nextCursor, rows };
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
  return { format, rowCount: rows.length, truncated: hasMore, hasMore, nextCursor, csv: lines.join("\r\n") };
}

function toCellValue(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function csvCell(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

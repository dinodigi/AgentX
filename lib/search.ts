import { and, eq, sql, asc, desc, type SQL } from "drizzle-orm";
import { tenantDb } from "./data-plane";
import { entries, type Collection, type Entry } from "@/db/schema";
import { fieldSearchable, type FieldDef } from "./field-types";
import { buildWhere, type WhereItem } from "./query";
import { ValidationError } from "./validation";

/**
 * Postgres full-text search over the JSONB entry data. One canonical tsvector
 * expression (searchVectorExpr) is shared by the query, the delivery query, and
 * the GIN index (lib/collections.ts), so the planner matches. 'simple' config
 * (no stemming/stopwords) keeps behavior predictable across locales.
 */

const NAME_RE = /^[a-z][a-z0-9_]*$/;
const MAX_SEARCH_LIMIT = 100;

export function searchableFields(fields: FieldDef[]): FieldDef[] {
  return fields.filter(fieldSearchable);
}

export function publicSearchableFields(fields: FieldDef[]): FieldDef[] {
  return fields.filter((f) => fieldSearchable(f) && f.publicRead === true);
}

/**
 * The tsvector over a field SUBSET. Field names are inlined via sql.raw (JSONB
 * paths can't be bind params), guarded by NAME_RE — the same DDL-safety argument
 * as the partial unique indexes. richtext fields get their HTML tags stripped so
 * markup never pollutes the index. Sorted by name so the expression is stable
 * (the index and the query must be byte-identical to planner-match).
 */
/** Raw SQL text of the tsvector expression — the ONE source used by the query,
 *  the delivery query, and the GIN index DDL, so they planner-match. */
export function searchVectorText(fields: FieldDef[]): string {
  const parts = fields
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((f) => {
      if (!NAME_RE.test(f.name)) throw new ValidationError(`search: invalid field name "${f.name}"`);
      return f.type === "richtext"
        ? `regexp_replace(coalesce(data->>'${f.name}',''),'<[^>]+>',' ','g')`
        : `coalesce(data->>'${f.name}','')`;
    });
  return `to_tsvector('simple', ${parts.join(" || ' ' || ")})`;
}

export function searchVectorExpr(fields: FieldDef[]): SQL {
  return sql.raw(searchVectorText(fields));
}

export interface SearchOpts {
  q: string;
  /** The field subset to search (all searchable for MCP; public for delivery). */
  fields: FieldDef[];
  where?: WhereItem[];
  limit?: number;
  offset?: number;
}

export interface SearchPage {
  rows: (Entry & { rank: number })[];
  limit: number;
  offset: number;
  hasMore: boolean;
}

/** Rank-ordered keyword search. Offset paging only (rank order isn't keyset-able). */
export async function searchEntriesPage(collection: Collection, opts: SearchOpts): Promise<SearchPage> {
  if (opts.fields.length === 0) {
    throw new ValidationError(
      "search is not enabled for this collection — no searchable fields; mark a text/richtext field searchable:true via define_collection",
    );
  }
  const q = opts.q.trim();
  if (q.length === 0 || q.length > 500) {
    throw new ValidationError("search: q must be 1–500 characters");
  }
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), MAX_SEARCH_LIMIT);
  const offset = Math.max(0, opts.offset ?? 0);

  const vec = searchVectorExpr(opts.fields);
  const query = sql`websearch_to_tsquery('simple', ${q})`;
  const conditions = [
    eq(entries.collectionId, collection.id),
    ...buildWhere(collection.fields, opts.where ?? []),
    sql`${vec} @@ ${query}`,
  ];

  const rank = sql<number>`ts_rank(${vec}, ${query})`;
  const rows = await (await tenantDb(collection.projectId))
    .select({
      id: entries.id,
      projectId: entries.projectId,
      collectionId: entries.collectionId,
      data: entries.data,
      idempotencyKey: entries.idempotencyKey,
      handledAt: entries.handledAt,
      createdAt: entries.createdAt,
      updatedAt: entries.updatedAt,
      rank,
    })
    .from(entries)
    .where(and(...conditions))
    .orderBy(desc(rank), asc(entries.id))
    .limit(limit + 1)
    .offset(offset);

  const hasMore = rows.length > limit;
  return {
    rows: rows.slice(0, limit).map((r) => ({ ...r, rank: Number(r.rank) })) as SearchPage["rows"],
    limit,
    offset,
    hasMore,
  };
}

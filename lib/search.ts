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

/**
 * One searchable leaf — top-level, or a text/richtext sub-field inside a
 * group/array (DM-5).
 *
 * `jsonPath` is null for a top-level field, which keeps the emitted SQL for a
 * collection with no nested searchable fields BYTE-IDENTICAL to what shipped
 * before DM-5. That is not cosmetic: syncSearchIndex rebuilds only when the
 * public subset changes, so an expression that drifted for untouched
 * collections would leave every existing GIN index in place but no longer
 * planner-matched — silent sequential scans, with nothing failing.
 */
export interface SearchTarget {
  /** Dotted path from the entry root. Identity + stable sort key. */
  path: string;
  /** jsonpath extracting this leaf, or null when it is a top-level field. */
  jsonPath: string | null;
  type: "text" | "richtext";
  /** Readable on the delivery API — see collectTargets for the cascade rule. */
  isPublic: boolean;
}

type Container = { fields?: FieldDef[]; item?: { type: string; fields?: FieldDef[] }; blocks?: { fields?: FieldDef[] }[] };

/**
 * Walk the field tree collecting every searchable leaf.
 *
 * PUBLIC VISIBILITY mirrors toPublicView exactly, and the two rules differ by
 * level: a TOP-LEVEL field is private unless `publicRead === true`, while inside
 * a public container a sub-field is public BY DEFAULT and opts out with
 * `publicRead === false`. Diverging from that would be a disclosure bug of the
 * SEC-1 class — delivery `?q=` would match on prose delivery never returns,
 * turning search into an oracle over private content.
 */
function collectTargets(fields: FieldDef[]): SearchTarget[] {
  const out: SearchTarget[] = [];
  const seen = new Set<string>();

  const seg = (name: string): string => {
    // Inlined into DDL and into a jsonpath literal, so the same NAME_RE guard
    // the partial unique indexes rely on applies at every segment, not just the
    // first. A name that cannot pass this never reaches SQL.
    if (!NAME_RE.test(name)) throw new ValidationError(`search: invalid field name "${name}"`);
    return name;
  };

  const descend = (spec: Container, prefix: string, jsonPrefix: string, parentPublic: boolean): void => {
    // Typed blocks share one jsonpath per sub-field name: two blocks that both
    // declare `text` collapse to $.body[*].text, which is correct — and the
    // dedupe below keeps the expression from listing it twice.
    const groups: FieldDef[][] = [];
    if (spec.fields) groups.push(spec.fields);
    if (spec.item?.fields) groups.push(spec.item.fields);
    for (const b of spec.blocks ?? []) if (b.fields) groups.push(b.fields);

    for (const subs of groups) {
      for (const sub of subs) {
        // Cascade opt-out, exactly as projectStructured applies it.
        const isPublic = parentPublic && sub.publicRead !== false;
        const path = `${prefix}.${seg(sub.name)}`;
        const jsonPath = `${jsonPrefix}.${sub.name}`;
        if (fieldSearchable(sub)) {
          if (!seen.has(path)) {
            seen.add(path);
            out.push({ path, jsonPath, type: sub.type as "text" | "richtext", isPublic });
          }
        }
        if (sub.type === "group" || sub.type === "array") {
          descend(sub as Container, path, sub.type === "array" ? `${jsonPath}[*]` : jsonPath, isPublic);
        }
      }
    }
  };

  for (const f of fields) {
    if (fieldSearchable(f)) {
      out.push({ path: seg(f.name), jsonPath: null, type: f.type as "text" | "richtext", isPublic: f.publicRead === true });
    }
    if (f.type === "group" || f.type === "array") {
      // A container is only reachable on delivery when IT is publicRead.
      const containerPublic = f.publicRead === true;
      descend(f as Container, seg(f.name), f.type === "array" ? `$.${f.name}[*]` : `$.${f.name}`, containerPublic);
    }
  }
  return out;
}

export function searchableTargets(fields: FieldDef[]): SearchTarget[] {
  return collectTargets(fields);
}

export function publicSearchableTargets(fields: FieldDef[]): SearchTarget[] {
  return collectTargets(fields).filter((t) => t.isPublic);
}

/**
 * The tsvector over a target SUBSET. Field names are inlined via sql.raw (JSONB
 * paths can't be bind params), guarded by NAME_RE — the same DDL-safety argument
 * as the partial unique indexes. richtext gets its HTML tags stripped so markup
 * never pollutes the index. Sorted so the expression is stable (the index and
 * the query must be byte-identical to planner-match).
 *
 * SHAPE, and why it is two halves rather than one concatenation: top-level
 * fields read out as text and join inside ONE to_tsvector, unchanged. A nested
 * leaf instead contributes its OWN tsvector term, appended with `||`. Rendering
 * the extracted JSON back to text and splicing it into the first half would
 * work — verified — but it pushes JSON syntax through the tokenizer, and the
 * two-half form leaves the pre-DM-5 expression untouched when nothing is nested.
 *
 * `jsonb_path_query_array` extracts ONLY the named sub-field. Indexing the whole
 * container instead would pull in every sibling string, so searching "dialogue"
 * would match every scene that merely CONTAINS a dialogue paragraph.
 */
/** Raw SQL text of the tsvector expression — the ONE source used by the query,
 *  the delivery query, and the GIN index DDL, so they planner-match. */
export function searchVectorText(targets: SearchTarget[]): string {
  const sorted = targets.slice().sort((a, b) => a.path.localeCompare(b.path));
  const flat = sorted
    .filter((t) => t.jsonPath === null)
    .map((t) =>
      t.type === "richtext"
        ? `regexp_replace(coalesce(data->>'${t.path}',''),'<[^>]+>',' ','g')`
        : `coalesce(data->>'${t.path}','')`,
    );
  const nested = sorted
    .filter((t) => t.jsonPath !== null)
    .map((t) =>
      t.type === "richtext"
        ? // Tags are stripped exactly as at top level. The extraction is rendered
          // to text first because regexp_replace has no jsonb form.
          `to_tsvector('simple', regexp_replace(coalesce(jsonb_path_query_array(data, '${t.jsonPath}') #>> '{}',''),'<[^>]+>',' ','g'))`
        : // to_tsvector(regconfig, jsonb) indexes only STRING leaves — a numeric
          // or boolean leaf yields an empty vector rather than a stray token.
          `to_tsvector('simple', jsonb_path_query_array(data, '${t.jsonPath}'))`,
    );

  const head = `to_tsvector('simple', ${flat.join(" || ' ' || ")})`;
  if (flat.length === 0) return nested.join(" || ");
  return nested.length === 0 ? head : [head, ...nested].join(" || ");
}

export function searchVectorExpr(targets: SearchTarget[]): SQL {
  return sql.raw(searchVectorText(targets));
}

export interface SearchOpts {
  q: string;
  /** The leaf subset to search (all searchable for MCP; public for delivery). */
  targets: SearchTarget[];
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
  if (opts.targets.length === 0) {
    throw new ValidationError(
      "search is not enabled for this collection — no searchable fields; mark a text/richtext field searchable:true via define_collection " +
        "(a text/richtext sub-field inside a group/array may be marked searchable too)",
    );
  }
  const q = opts.q.trim();
  if (q.length === 0 || q.length > 500) {
    throw new ValidationError("search: q must be 1–500 characters");
  }
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), MAX_SEARCH_LIMIT);
  const offset = Math.max(0, opts.offset ?? 0);

  const vec = searchVectorExpr(opts.targets);
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

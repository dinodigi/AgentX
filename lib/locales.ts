import { unstable_cache, revalidateTag } from "next/cache";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { tenantDb } from "./data-plane";
import {
  projects,
  collections,
  entries,
  entriesTrash,
  type ProjectLocales,
} from "@/db/schema";
import { fieldLocalized, type FieldDef } from "./field-types";
import { ValidationError } from "./validation";

/**
 * Project locale registry (Phase 18 J3). Locales are project-level config —
 * fallback chains and the admin switcher are project-wide concerns, so this is
 * NOT per-collection. Kept in its own module: lib/validation.ts receives the
 * config as an argument (J5) and must never import from here (cycle guard).
 */

/** BCP-47-shaped tag, normalized lowercase: "en", "pt-br", "zh-hans". */
export const LOCALE_RE = /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/;
const MAX_SUPPORTED = 16;

/** Cached read; shares the project:{id} tag so branding/locales edits converge. */
export async function getLocales(projectId: string): Promise<ProjectLocales | null> {
  const cached = unstable_cache(
    async () => {
      const rows = await db
        .select({ locales: projects.locales })
        .from(projects)
        .where(eq(projects.id, projectId))
        .limit(1);
      return rows[0]?.locales ?? null;
    },
    ["locales", projectId],
    { tags: [`project:${projectId}`], revalidate: 60 },
  );
  return cached();
}

export interface LocalesPlan {
  removingLocales: string[];
  defaultChange: { from: string; to: string } | null;
  /** Stored translations that a confirmed removal purges permanently. */
  variantsLost: { collection: string; field: string; locale: string; entries: number }[];
  /** Entries whose localized fields would vanish from delivery output under the new default. */
  entriesMissingNewDefault: { collection: string; field: string; entries: number }[];
}

export type SetLocalesResult =
  | { applied: true; locales: ProjectLocales; purgedVariants: LocalesPlan["variantsLost"] }
  | { applied: false; plan: LocalesPlan; hint: string };

function normalizeLocales(input: ProjectLocales): ProjectLocales {
  const seen = new Set<string>();
  const supported: string[] = [];
  for (const raw of input.supported) {
    const tag = raw.trim().toLowerCase();
    if (!LOCALE_RE.test(tag)) {
      throw new ValidationError(
        `"${raw}" is not a valid locale tag — use BCP-47-style tags like "en", "de", "pt-br"`,
      );
    }
    if (!seen.has(tag)) {
      seen.add(tag);
      supported.push(tag);
    }
  }
  if (supported.length === 0) {
    throw new ValidationError("supported must contain at least one locale tag");
  }
  if (supported.length > MAX_SUPPORTED) {
    throw new ValidationError(`at most ${MAX_SUPPORTED} supported locales`);
  }
  const def = input.default.trim().toLowerCase();
  if (!seen.has(def)) {
    throw new ValidationError(
      `default locale "${def}" must be one of supported — add it to the supported list`,
    );
  }
  return { default: def, supported };
}

/** Fields storing {locale: value} variant maps. None can exist before J5 ships. */
function localizedFields(fields: FieldDef[]): FieldDef[] {
  return fields.filter(fieldLocalized);
}

export function hasLocalizedFields(fields: FieldDef[]): boolean {
  return fields.some(fieldLocalized);
}

/**
 * Flatten localized values in a delivery view to ONE locale's plain value —
 * runs strictly on toPublicView's output, so it can widen nothing. The
 * requested locale falls back to the default variant; neither present = the
 * key is omitted (an absent optional field). Non-object values pass through
 * unchanged — pre-localization strings and the J8 backfill window stay safe.
 */
export function localizeView(
  view: Record<string, unknown>,
  fields: FieldDef[],
  locales: ProjectLocales | null,
  requested?: string,
): Record<string, unknown> {
  if (!locales) return view;
  for (const f of fields) {
    if (!fieldLocalized(f) || !(f.name in view)) continue;
    const v = view[f.name];
    if (typeof v !== "object" || v === null || Array.isArray(v)) continue;
    const variants = v as Record<string, unknown>;
    const picked = variants[requested ?? locales.default] ?? variants[locales.default];
    if (picked === undefined) delete view[f.name];
    else view[f.name] = picked;
  }
  return view;
}

/**
 * Set the project's locale registry. Destructive shapes — dropping a supported
 * locale that holds stored translations, or changing the default while
 * translations exist — return a counted plan and require confirm:true
 * (define_collection's diff-plan precedent). A confirmed locale removal PURGES
 * the dropped variants from stored entries (live + trash), so config and data
 * never disagree about what "valid" means.
 */
export async function setLocales(
  projectId: string,
  input: ProjectLocales,
  confirm = false,
): Promise<SetLocalesResult> {
  const next = normalizeLocales(input);

  const [project] = await db
    .select({ locales: projects.locales })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!project) throw new ValidationError("project not found", "E_NOT_FOUND");
  const current = project.locales;

  const removed = current ? current.supported.filter((l) => !next.supported.includes(l)) : [];
  const defaultChange =
    current && current.default !== next.default
      ? { from: current.default, to: next.default }
      : null;

  const variantsLost: LocalesPlan["variantsLost"] = [];
  const entriesMissingNewDefault: LocalesPlan["entriesMissingNewDefault"] = [];

  // Count impact only when the change is destructive-shaped AND localized
  // fields exist to hold variants (zero until J5 enables the field knob).
  // Collections (config) are control-plane; the variant counts read tenant data.
  if (removed.length > 0 || defaultChange) {
    const tdb = await tenantDb(projectId);
    const cols = await db
      .select({ id: collections.id, name: collections.name, fields: collections.fields })
      .from(collections)
      .where(eq(collections.projectId, projectId));
    for (const col of cols) {
      for (const f of localizedFields(col.fields as FieldDef[])) {
        const variantMap = sql`${entries.data} -> ${f.name}`;
        for (const locale of removed) {
          const [row] = await tdb
            .select({ n: sql<number>`count(*)::int` })
            .from(entries)
            .where(
              and(
                eq(entries.collectionId, col.id),
                sql`jsonb_typeof(${variantMap}) = 'object'`,
                sql`jsonb_exists(${variantMap}, ${locale})`,
              ),
            );
          if (row.n > 0) {
            variantsLost.push({ collection: col.name, field: f.name, locale, entries: row.n });
          }
        }
        if (defaultChange) {
          const [row] = await tdb
            .select({ n: sql<number>`count(*)::int` })
            .from(entries)
            .where(
              and(
                eq(entries.collectionId, col.id),
                sql`jsonb_typeof(${variantMap}) = 'object'`,
                sql`NOT jsonb_exists(${variantMap}, ${defaultChange.to})`,
              ),
            );
          if (row.n > 0) {
            entriesMissingNewDefault.push({ collection: col.name, field: f.name, entries: row.n });
          }
        }
      }
    }
  }

  const destructive = variantsLost.length > 0 || entriesMissingNewDefault.length > 0;
  if (destructive && !confirm) {
    const parts: string[] = [];
    if (variantsLost.length > 0) {
      const total = variantsLost.reduce((s, v) => s + v.entries, 0);
      parts.push(
        `dropping ${variantsLost.map((v) => `"${v.locale}"`).filter((v, i, a) => a.indexOf(v) === i).join(", ")} permanently purges ${total} stored translation variant(s)`,
      );
    }
    if (entriesMissingNewDefault.length > 0) {
      const total = entriesMissingNewDefault.reduce((s, v) => s + v.entries, 0);
      parts.push(
        `changing the default to "${next.default}" makes ${total} entr(ies) lacking that variant omit those fields from delivery output`,
      );
    }
    return {
      applied: false,
      plan: { removingLocales: removed, defaultChange, variantsLost, entriesMissingNewDefault },
      hint: parts.join("; ") + " — re-run with confirm:true to apply",
    };
  }

  await db.update(projects).set({ locales: next }).where(eq(projects.id, projectId));

  // Confirmed removal purges the dropped locales' variants so no stored value
  // ever violates the compiled schema (strict-validation invariant). Same
  // single-statement jsonb shape as the rename backfill; trash rows included,
  // matching how rename-backfill treats entries_trash.
  if (variantsLost.length > 0) {
    const tdb = await tenantDb(projectId);
    for (const v of variantsLost) {
      const [col] = await db
        .select({ id: collections.id })
        .from(collections)
        .where(and(eq(collections.projectId, projectId), eq(collections.name, v.collection)))
        .limit(1);
      if (!col) continue;
      for (const table of [entries, entriesTrash] as const) {
        // ::text casts on EVERY bound param: inside .set() drizzle types params
        // from the jsonb column context, making `-> $n` / `- $n` jsonb-jsonb.
        const variantMap = sql`${table.data} -> ${v.field}::text`;
        await tdb
          .update(table)
          .set({
            data: sql`jsonb_set(${table.data}, ARRAY[${v.field}::text], (${variantMap}) - ${v.locale}::text)`,
          })
          .where(
            and(
              eq(table.collectionId, col.id),
              sql`jsonb_typeof(${variantMap}) = 'object'`,
              sql`jsonb_exists(${variantMap}, ${v.locale}::text)`,
            ),
          );
      }
    }
  }

  revalidateTag(`project:${projectId}`);
  return { applied: true, locales: next, purgedVariants: variantsLost };
}

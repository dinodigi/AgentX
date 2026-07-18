import "server-only";
import { eq } from "drizzle-orm";
import { revalidateTag } from "next/cache";
import { db } from "@/db";
import { collections, projects } from "@/db/schema";
import { validateFieldDefs, ValidationError, formatZodError } from "./validation";
import { MAX_BLOCK_TYPES, type BlockDef, type FieldDef } from "./field-types";
import { z } from "zod";

/**
 * v2 Track 1b: the project-level BLOCK LIBRARY — "declare a block as a
 * template". A named block is defined once (define_block) and referenced by
 * NAME from any collection: array:{blocks:["hero", ...]} — define_collection
 * MATERIALIZES the full def into the stored fields (stamped `library`), so
 * stored collection.fields stay fully concrete and the entire validation /
 * F2-F3 / resolver pipeline is untouched.
 *
 * Editing a used library block is Terraform-style: the change is validated
 * against EVERY using collection first (all-or-nothing), requires confirm,
 * then re-materializes into each. Deleting refuses while in use.
 */

export type LibraryBlock = { label: string; fields: FieldDef[] };
export type BlockLibrary = Record<string, LibraryBlock>;

const NAME_RE = /^[a-z][a-z0-9_]*$/;
const MAX_LIBRARY_BLOCKS = 50;

async function loadLibrary(projectId: string): Promise<BlockLibrary> {
  const [row] = await db
    .select({ lib: projects.blockLibrary })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  return row?.lib ?? {};
}

/**
 * Replace string refs inside any `blocks: [...]` array of a RAW (pre-zod)
 * fields payload with the library def, stamped `library`. Purely additive on
 * unknown input — anything unexpected is left as-is for the meta-schema to
 * reject with its own message. Unknown ref names error here with the catalog.
 */
export function resolveLibraryBlocks(rawFields: unknown, library: BlockLibrary): unknown {
  const resolveNode = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(resolveNode);
    if (!node || typeof node !== "object") return node;
    const src = node as Record<string, unknown>;
    const out: Record<string, unknown> = { ...src };
    if (Array.isArray(src.blocks)) {
      out.blocks = src.blocks.map((b) => {
        if (typeof b !== "string") return resolveNode(b);
        const def = library[b];
        if (!def) {
          throw new ValidationError(
            `unknown library block "${b}" — available: ${Object.keys(library).join(", ") || "(none — define_block first)"}; or inline the block def`,
            "E_VALIDATION",
          );
        }
        return { name: b, label: def.label, fields: def.fields, library: b };
      });
    }
    if (Array.isArray(src.fields)) out.fields = src.fields.map(resolveNode);
    if (src.item && typeof src.item === "object") out.item = resolveNode(src.item);
    return out;
  };
  return resolveNode(rawFields);
}

/** Rebuild a stored fields tree with library block `name` re-materialized. */
function substituteBlock(fields: FieldDef[], name: string, def: LibraryBlock): FieldDef[] {
  return fields.map((f): FieldDef => {
    if (f.type === "group") return { ...f, fields: substituteBlock(f.fields, name, def) };
    if (f.type === "array") {
      if (f.blocks) {
        return {
          ...f,
          blocks: f.blocks.map((b) =>
            (b as BlockDef).library === name
              ? { name: b.name, label: def.label, fields: def.fields, library: name }
              : { ...b, fields: substituteBlock(b.fields, name, def) },
          ),
        };
      }
      if (f.item?.type === "group") {
        return { ...f, item: { ...f.item, fields: substituteBlock(f.item.fields, name, def) } };
      }
    }
    return f;
  });
}

function usesBlock(fields: FieldDef[], name: string): boolean {
  return fields.some((f) => {
    if (f.type === "group") return usesBlock(f.fields, name);
    if (f.type === "array") {
      if (f.blocks) return f.blocks.some((b) => (b as BlockDef).library === name || usesBlock(b.fields, name));
      if (f.item?.type === "group") return usesBlock(f.item.fields, name);
    }
    return false;
  });
}

export interface DefineBlockResult {
  applied: boolean;
  requiresConfirmation?: boolean;
  /** Collections whose stored fields were (or would be) re-materialized. */
  usedBy?: string[];
  hint?: string;
}

const defineBlockInput = z.object({
  name: z.string().regex(NAME_RE, "block name must be snake_case starting with a letter"),
  label: z.string().min(1),
  fields: z.array(z.unknown()).min(1),
});

export async function defineBlock(
  projectId: string,
  input: { name: string; label: string; fields: unknown[]; confirm?: boolean },
): Promise<DefineBlockResult> {
  const parsed = defineBlockInput.parse(input);

  // Validate the block IN ITS REAL CONTEXT: wrapped as one blocks-array field,
  // so walkStructure applies the one-level rule / _type reservation / caps at
  // the depth the block will actually live at.
  let fields: FieldDef[];
  try {
    const synthetic = validateFieldDefs([
      { name: "lib_probe", label: "probe", type: "array", blocks: [{ name: parsed.name, label: parsed.label, fields: parsed.fields }] },
    ]) as Extract<FieldDef, { type: "array" }>[];
    fields = synthetic[0].blocks![0].fields;
  } catch (e) {
    if (e instanceof z.ZodError) throw new ValidationError(formatZodError(e), "E_VALIDATION");
    throw e;
  }

  const library = await loadLibrary(projectId);
  const isNew = !(parsed.name in library);
  if (isNew && Object.keys(library).length >= MAX_LIBRARY_BLOCKS) {
    throw new ValidationError(`block library is full (max ${MAX_LIBRARY_BLOCKS})`, "E_VALIDATION");
  }

  // Fan-out: every collection carrying a materialization of this block.
  const all = await db
    .select({ id: collections.id, name: collections.name, fields: collections.fields })
    .from(collections)
    .where(eq(collections.projectId, projectId));
  const using = all.filter((c) => usesBlock(c.fields as FieldDef[], parsed.name));

  if (!isNew && using.length > 0 && !input.confirm) {
    return {
      applied: false,
      requiresConfirmation: true,
      usedBy: using.map((c) => c.name),
      hint:
        `"${parsed.name}" is used by ${using.length} collection(s) — re-run with confirm: true to ` +
        `re-materialize the new shape into all of them (existing entries keep their stored data; ` +
        `new writes validate against the new shape)`,
    };
  }

  const def: LibraryBlock = { label: parsed.label, fields };

  // Validate EVERY using collection with the substitution applied — all-or-
  // nothing: a block edit that would make any collection's schema invalid
  // (e.g. depth rules in its context) rejects before anything is written.
  const rebuilt = using.map((c) => {
    const next = substituteBlock(c.fields as FieldDef[], parsed.name, def);
    try {
      validateFieldDefs(next);
    } catch (e) {
      const detail = e instanceof z.ZodError ? formatZodError(e) : e instanceof Error ? e.message : String(e);
      throw new ValidationError(
        `block edit would break collection "${c.name}": ${detail}`,
        "E_VALIDATION",
      );
    }
    return { id: c.id, next };
  });

  await db
    .update(projects)
    .set({ blockLibrary: { ...library, [parsed.name]: def } })
    .where(eq(projects.id, projectId));
  for (const r of rebuilt) {
    await db.update(collections).set({ fields: r.next, updatedAt: new Date() }).where(eq(collections.id, r.id));
  }
  // Same tags collections.ts uses — schema caches converge (15s TTL fleet-wide).
  revalidateTag(`collections:${projectId}`);
  revalidateTag(`project:${projectId}`);
  return { applied: true, usedBy: using.map((c) => c.name) };
}

export async function deleteBlock(projectId: string, name: string): Promise<{ deleted: boolean; usedBy?: string[] }> {
  const library = await loadLibrary(projectId);
  if (!(name in library)) {
    throw new ValidationError(`unknown library block "${name}"`, "E_NOT_FOUND");
  }
  const all = await db
    .select({ name: collections.name, fields: collections.fields })
    .from(collections)
    .where(eq(collections.projectId, projectId));
  const using = all.filter((c) => usesBlock(c.fields as FieldDef[], name)).map((c) => c.name);
  if (using.length > 0) {
    return { deleted: false, usedBy: using }; // refuse while in use — remove the usages first
  }
  const { [name]: _gone, ...rest } = library;
  await db.update(projects).set({ blockLibrary: rest }).where(eq(projects.id, projectId));
  revalidateTag(`project:${projectId}`);
  return { deleted: true };
}

export async function listBlocks(
  projectId: string,
): Promise<{ name: string; label: string; fields: number; usedBy: string[] }[]> {
  const library = await loadLibrary(projectId);
  const names = Object.keys(library);
  if (names.length === 0) return [];
  const all = await db
    .select({ name: collections.name, fields: collections.fields })
    .from(collections)
    .where(eq(collections.projectId, projectId));
  return names.map((n) => ({
    name: n,
    label: library[n].label,
    fields: library[n].fields.length,
    usedBy: all.filter((c) => usesBlock(c.fields as FieldDef[], n)).map((c) => c.name),
  }));
}

export { loadLibrary as getBlockLibrary };

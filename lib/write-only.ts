import { fieldWriteOnly, type FieldDef } from "./field-types";

/**
 * SEC-1 — the write-only guarantee, in one place.
 *
 * A write-only field (`{type:"text", writeOnly:true}`) can be written but never
 * read back. The invariant every surface is tested against is deliberately
 * absolute and easy to state:
 *
 *   **A write-only field's NAME never appears as a key in any read payload.**
 *
 * Not masked, not `"***"` — absent. A marker value would be a value, and a
 * value is something that gets logged, diffed, cached and eventually written
 * back. Absence composes with the platform's existing partial-update rule: an
 * agent can read an entry, edit it, and write it back without touching (or
 * silently clearing) the credential.
 *
 * The guarantee is enforced in TWO layers, because either alone has a hole:
 *
 *  1. **Storage minimisation.** The value is written to `entries.data` (and the
 *     trash row it moves to) and NOWHERE else — `recordVersion` and the change
 *     feed's `rowValues` strip it before the INSERT, and event payloads strip it
 *     before they leave the process. A secret that was never copied cannot leak
 *     from the copy.
 *  2. **Read redaction.** Every read boundary calls `redact` anyway. This is not
 *     belt-and-braces: a field can be FLIPPED to write-only after the fact, and
 *     history written while it was an ordinary text field still holds plaintext
 *     in old version snapshots and old feed rows. Layer 1 protects new writes;
 *     layer 2 protects the archive.
 *
 * `redact` returns the SAME object when there is nothing to strip, so the
 * common case (no write-only fields anywhere) costs one `.some()` per call.
 */

/** Names of a collection's write-only fields. Empty for almost every collection. */
export function writeOnlyNames(fields: FieldDef[]): string[] {
  const out: string[] = [];
  for (const f of fields) if (fieldWriteOnly(f)) out.push(f.name);
  return out;
}

export function hasWriteOnly(fields: FieldDef[]): boolean {
  return fields.some(fieldWriteOnly);
}

/**
 * Strip every write-only key from an entry-data object. Null/undefined pass
 * through so callers can pipe optional pre-images without a guard.
 */
export function redact<T extends Record<string, unknown> | null | undefined>(
  fields: FieldDef[],
  data: T,
): T {
  if (!data) return data;
  let out: Record<string, unknown> | null = null;
  for (const f of fields) {
    if (!fieldWriteOnly(f)) continue;
    if (f.name in data) {
      out ??= { ...data };
      delete out[f.name];
    }
  }
  return (out ?? data) as T;
}

/** Redact the `data` of each row in a list, leaving every sibling key intact. */
export function redactRows<R extends { data: Record<string, unknown> }>(
  fields: FieldDef[],
  rows: R[],
): R[] {
  if (!hasWriteOnly(fields)) return rows;
  return rows.map((r) => ({ ...r, data: redact(fields, r.data) }));
}

/**
 * Carry the CURRENT stored write-only values into a full replacement payload.
 *
 * The dangerous case this exists for: any write path that replaces the whole
 * row from data that has been through a read. A version snapshot, a
 * before-write hook's transform, and an admin form submit have all had the
 * credential redacted out of them — writing them back verbatim would silently
 * CLEAR a stored credential, which is worse than leaking one in the sense that
 * nothing reports it. Explicit unset stays available via `null` (the top-level
 * unset rule), so intent is never inferred from absence.
 */
export function preserveWriteOnly(
  fields: FieldDef[],
  current: Record<string, unknown>,
  replacement: Record<string, unknown>,
): Record<string, unknown> {
  for (const f of fields) {
    if (!fieldWriteOnly(f)) continue;
    if (f.name in current) replacement[f.name] = current[f.name];
    else delete replacement[f.name];
  }
  return replacement;
}

/**
 * Refuse a surface that would turn a write-only field into a read. Shared by
 * `select`, relation labelField resolution, and the define-time gates, so every
 * refusal reads the same way and names the same reason.
 */
export function writeOnlyRefusal(fieldName: string, what: string): string {
  return `"${fieldName}" is a write-only field — it can be written but never read back, so ${what}`;
}

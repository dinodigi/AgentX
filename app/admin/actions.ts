"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { entries } from "@/db/schema";
import { getCollection } from "@/lib/collections";
import { getProjectRole, getViewer } from "@/lib/access";
import { createEntry, updateEntry, deleteEntry, ValidationError } from "@/lib/entries";
import { coerceFormData } from "@/lib/admin-form";
import { getLocales } from "@/lib/locales";

/**
 * Save (create or update) an entry from the auto-generated admin form.
 * Bound in the page as saveEntry.bind(null, projectId, collectionName, entryId).
 * Returns { error } on validation failure; redirects to the entry list on success.
 */
export async function saveEntry(
  projectId: string,
  collectionName: string,
  entryId: string | null,
  formData: FormData,
): Promise<{ error?: string } | void> {
  const role = await getProjectRole(projectId);
  if (!role) return { error: "no access to this project" };

  const collection = await getCollection(projectId, collectionName);
  if (!collection) return { error: "collection not found" };

  // J7: the form says which locale its localized inputs belong to. A locale
  // that is no longer supported errors rather than silently saving the text
  // under the default locale (which would corrupt translations).
  const locales = await getLocales(projectId);
  const requested = formData.get("__locale");
  let wrapLocale = locales?.default ?? null;
  if (typeof requested === "string" && requested !== "") {
    if (!locales || !locales.supported.includes(requested)) {
      return { error: `locale "${requested}" is no longer supported — reload the form` };
    }
    wrapLocale = requested;
  }
  const data = coerceFormData(collection.fields, formData, wrapLocale);

  const viewer = await getViewer();
  const actor = { type: "admin" as const, userId: viewer?.userId };

  try {
    if (entryId) {
      await updateEntry(projectId, collection, entryId, data, actor);
    } else {
      await createEntry(projectId, collection, data, { actor });
    }
  } catch (e) {
    if (e instanceof ValidationError) return { error: e.message };
    return { error: "could not save entry" };
  }

  // Success — leave the try/catch before redirecting (redirect throws by design).
  redirect(`/admin/${projectId}/${collectionName}`);
}

/**
 * Toggle the handled flag on an inbox submission. Workflow metadata, not entry
 * data — it never touches the validated payload, fires no events, and is
 * invisible to the delivery API.
 */
export async function toggleHandledAction(
  projectId: string,
  collectionName: string,
  entryId: string,
): Promise<void> {
  // A plain form action can't surface errors; unauthorized/missing = no-op.
  const role = await getProjectRole(projectId);
  if (!role) return;
  const collection = await getCollection(projectId, collectionName);
  if (!collection) return;

  const [row] = await db
    .select({ handledAt: entries.handledAt })
    .from(entries)
    .where(and(eq(entries.id, entryId), eq(entries.collectionId, collection.id)))
    .limit(1);
  if (!row) return;

  await db
    .update(entries)
    .set({ handledAt: row.handledAt ? null : new Date() })
    .where(eq(entries.id, entryId));
  revalidatePath(`/admin/${projectId}/${collectionName}`);
  revalidatePath(`/admin/${projectId}`, "layout");
}

/** Delete an asset from the Media page. Blocked while entries reference it. */
export async function deleteAssetAction(
  projectId: string,
  assetId: string,
): Promise<{ error?: string } | void> {
  const role = await getProjectRole(projectId);
  if (!role) return { error: "no access to this project" };
  try {
    const { deleteAsset } = await import("@/lib/r2");
    await deleteAsset(projectId, assetId);
  } catch (e) {
    if (e instanceof ValidationError) return { error: e.message };
    return { error: "could not delete asset" };
  }
  revalidatePath(`/admin/${projectId}/assets`);
}

/** Delete an entry from the admin edit page. */
export async function deleteEntryAction(
  projectId: string,
  collectionName: string,
  entryId: string,
): Promise<{ error?: string } | void> {
  const role = await getProjectRole(projectId);
  if (!role) return { error: "no access to this project" };

  const collection = await getCollection(projectId, collectionName);
  if (!collection) return { error: "collection not found" };

  const viewer = await getViewer();
  await deleteEntry(collection, entryId, { type: "admin", userId: viewer?.userId });
  redirect(`/admin/${projectId}/${collectionName}`);
}

/** Restore a trashed entry from the admin Trash page. */
export async function restoreEntryAction(
  projectId: string,
  collectionName: string,
  entryId: string,
): Promise<{ error?: string } | void> {
  const role = await getProjectRole(projectId);
  if (!role) return { error: "no access to this project" };
  const collection = await getCollection(projectId, collectionName);
  if (!collection) return { error: "collection not found" };
  const viewer = await getViewer();
  try {
    const { restoreEntry } = await import("@/lib/trash");
    await restoreEntry(projectId, collection, entryId, { type: "admin", userId: viewer?.userId });
  } catch (e) {
    if (e instanceof ValidationError) return { error: e.message };
    return { error: "could not restore entry" };
  }
  revalidatePath(`/admin/${projectId}/trash`);
}

/** Permanently purge a trashed entry from the admin Trash page. */
export async function purgeEntryAction(
  projectId: string,
  collectionName: string,
  entryId: string,
): Promise<{ error?: string } | void> {
  const role = await getProjectRole(projectId);
  if (!role) return { error: "no access to this project" };
  const collection = await getCollection(projectId, collectionName);
  if (!collection) return { error: "collection not found" };
  const viewer = await getViewer();
  try {
    const { purgeEntry } = await import("@/lib/trash");
    await purgeEntry(projectId, collection, entryId, {
      confirm: true,
      actor: { type: "admin", userId: viewer?.userId },
    });
  } catch (e) {
    if (e instanceof ValidationError) return { error: e.message };
    return { error: "could not purge entry" };
  }
  revalidatePath(`/admin/${projectId}/trash`);
}

/** Roll an entry back to a past version from the entry edit page. */
export async function restoreVersionAction(
  projectId: string,
  collectionName: string,
  entryId: string,
  versionId: string,
): Promise<{ error?: string } | void> {
  const role = await getProjectRole(projectId);
  if (!role) return { error: "no access to this project" };
  const collection = await getCollection(projectId, collectionName);
  if (!collection) return { error: "collection not found" };
  const viewer = await getViewer();
  try {
    const { restoreEntryVersion } = await import("@/lib/entries");
    await restoreEntryVersion(projectId, collection, entryId, versionId, {
      type: "admin",
      userId: viewer?.userId,
    });
  } catch (e) {
    if (e instanceof ValidationError) return { error: e.message };
    return { error: "could not restore version" };
  }
  revalidatePath(`/admin/${projectId}/${collectionName}/${entryId}`);
}

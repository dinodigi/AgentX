"use server";

import { redirect } from "next/navigation";
import { getCollection } from "@/lib/collections";
import { getProjectRole, getViewer } from "@/lib/access";
import { createEntry, updateEntry, deleteEntry, ValidationError } from "@/lib/entries";
import { coerceFormData } from "@/lib/admin-form";

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

  const data = coerceFormData(collection.fields, formData);

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

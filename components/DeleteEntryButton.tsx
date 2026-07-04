"use client";

import { useState } from "react";
import { Trash2 } from "lucide-react";

/** Two-click delete: first click arms it, second confirms. No modal needed. */
export function DeleteEntryButton({
  action,
}: {
  action: () => Promise<{ error?: string } | void>;
}) {
  const [armed, setArmed] = useState(false);
  const [pending, setPending] = useState(false);

  return (
    <button
      type="button"
      disabled={pending}
      onClick={async () => {
        if (!armed) {
          setArmed(true);
          setTimeout(() => setArmed(false), 3000);
          return;
        }
        setPending(true);
        await action();
        setPending(false);
      }}
      className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm ${
        armed
          ? "border-red-600 bg-red-600 text-white"
          : "border-gray-200 text-gray-500 hover:border-red-200 hover:text-red-600"
      }`}
    >
      <Trash2 className="h-4 w-4" />
      {pending ? "Deleting…" : armed ? "Confirm delete" : "Delete"}
    </button>
  );
}

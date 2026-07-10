"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronsUpDown, X } from "lucide-react";
import type { RelationChoice } from "./EntryForm";

/**
 * Typeahead picker for relation fields — the plain <select> dies past a few
 * hundred rows. Choices are preloaded (capped at 500 by loadRelationChoices);
 * filtering is client-side, and the cap is surfaced so nobody thinks a missing
 * entry doesn't exist.
 */
export function RelationCombobox({
  name,
  choices,
  initialId,
}: {
  name: string;
  choices: RelationChoice[];
  initialId: string;
}) {
  const initial = choices.find((c) => c.id === initialId) ?? null;
  const [selected, setSelected] = useState<RelationChoice | null>(initial);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matches = q
      ? choices.filter((c) => c.label.toLowerCase().includes(q))
      : choices;
    return matches.slice(0, 50);
  }, [choices, query]);

  useEffect(() => {
    function onPointerDown(e: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, []);

  return (
    <div ref={rootRef} className="relative">
      <input type="hidden" name={name} value={selected?.id ?? ""} />

      {selected ? (
        <div className="field-input flex items-center justify-between gap-2">
          <span className="truncate">{selected.label}</span>
          <button
            type="button"
            title="Clear"
            onClick={() => {
              setSelected(null);
              setQuery("");
              setOpen(true);
            }}
            className="shrink-0 text-[--color-ink-mute] transition-colors hover:text-[--color-ink]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      ) : (
        <div className="relative">
          <input
            type="text"
            value={query}
            placeholder="Type to search…"
            onFocus={() => setOpen(true)}
            onChange={(e) => {
              setQuery(e.target.value);
              setOpen(true);
            }}
            className="field-input pr-8"
          />
          <ChevronsUpDown className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[--color-ink-mute]" />
        </div>
      )}

      {open && !selected && (
        <div className="absolute z-20 mt-1 max-h-64 w-full overflow-y-auto rounded-lg border border-[--color-line] bg-[--color-card] shadow-lg">
          {filtered.length === 0 ? (
            <p className="px-3 py-2.5 text-sm text-[--color-ink-mute]">No matches.</p>
          ) : (
            filtered.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => {
                  setSelected(c);
                  setOpen(false);
                }}
                className="block w-full truncate px-3 py-2 text-left text-sm transition-colors hover:bg-[--color-brand-wash]"
              >
                {c.label}
              </button>
            ))
          )}
          {choices.length >= 500 && (
            <p className="border-t border-[--color-line] px-3 py-2 text-xs text-[--color-ink-mute]">
              Showing the first 500 entries — narrow by typing if yours is missing.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

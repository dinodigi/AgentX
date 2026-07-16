# Structured Fields — `group` + `array` (repeatable groups) for pages

**Status:** COMPLETE — Layers 1–3b SHIPPED & verified (2026-07-15, local master, not pushed). L1 group/array types + recursive validation + caps (76f44a1). L2 recursive projection (F3) + write-gate (F2) + nested asset resolution (7de4788). L3a admin JSON editor (0a5c7f1). L3b visual repeater editor `StructuredFieldEditor` (9344011, browser-verified). Structured content works across MCP, the admin (visual add/remove/nested), and delivery (safe). Only reorder-drag is deferred polish.
**Goal:** let a collection model **page-shaped content** — a page is one entry with a repeatable list of typed sections — without becoming a page-builder.
**Decision recorded:** taxonomies/glossaries are NOT getting first-class types (they compose cleanly from `collection + relation`; only revisit relation/tree support if deep hierarchy becomes a real need). This doc is only the page-model gap.

---

## The gap (one paragraph)

A collection is a flat set of fields; an entry is one flat record — perfect for a blog, wrong for a page. A page is a **composition of heterogeneous, often-repeating sections** (hero, N feature cards, testimonials, CTA). The current field types (text, richtext, number, boolean, date, enum, asset, relation) can't express *"N of a nested shape."* Faking it with a child collection + relation is a **forced fit** — authoring/ordering/serving a page as a graph of separate entries is the "really bad experience." The fix is **two new field types**; blocks fall out of them later.

## Scope

**In (v1):**
- `group` — a field whose value is a nested set of sub-fields.
- `array` — a field whose value is a list of items, each a scalar OR a group (repeatable groups).
- Inline storage (in the entry's existing JSONB `data`), recursive validation, recursive delivery projection, structural caps, admin rendering.

**Explicitly OUT (hold the line):**
- ❌ Typed-blocks / flexible-content (a `sections` array where each item is one of several *discriminated* block types). This is the page-builder; it's a clean v2 *layered on the array primitive*, not now.
- ❌ Visual drag-and-drop builder.
- ❌ Relational "sections-as-entries" model.
- ❌ Nested **relation** fields inside group/array (v2 — relation resolution carries org-scope + publicFilter/F3 recursion; heavy). v1 nested item types = text, richtext, number, boolean, date, enum, **asset**.
- ❌ Filtering/sorting on nested fields or sub-fields (delivery `where`/`orderBy` stays top-level scalars only).
- ❌ `computed` / `unique` inside nested structures.

---

## The model

Two additions to `FieldDef` (`lib/field-types.ts`). Values live in the entry's JSONB `data` — **no DB migration.**

```ts
// group: a named nested field set. Value = an object.
{ name: "seo", label: "SEO", type: "group", publicRead: true, fields: [
    { name: "metaTitle",       label: "Meta title",       type: "text" },
    { name: "metaDescription", label: "Meta description", type: "text" },
    { name: "ogImage",         label: "OG image",         type: "asset" },
]}
// entry.data.seo = { metaTitle: "...", metaDescription: "...", ogImage: "<assetId>" }

// array of group: repeatable sections. Value = a list of objects.
{ name: "sections", label: "Sections", type: "array", publicRead: true, maxItems: 50, item:
    { type: "group", fields: [
        { name: "heading", label: "Heading", type: "text" },
        { name: "body",    label: "Body",    type: "richtext" },
        { name: "image",   label: "Image",   type: "asset" },
    ]}
}
// entry.data.sections = [ { heading, body, image }, { heading, body, image }, ... ]

// array of scalar: a simple list. Value = a list of scalars.
{ name: "tags", label: "Tags", type: "array", maxItems: 20, item: { type: "text" } }
```

**Recursion rules (bounded on purpose):**
- `group.fields` = named `FieldDef[]` (each sub-field has a `name` = its object key).
- `array.item` = a **nameless** scalar spec (`{type, ...constraints}`) **or** a `group` (`{type:"group", fields}`).
- **No array-of-array** directly (nest via `array → group → array` if ever needed).
- **Max depth = 3** nesting levels (e.g. `page → sections[] → section group → (one scalar level)`). Rejected at define time past that.

---

## Work, by area (with file touch points)

### 1. Field definition & types — `lib/field-types.ts`
Add `"group"` and `"array"` to `FIELD_TYPES`; add the two variants to the `FieldDef` union (group has `fields`, array has `item` + `maxItems`). Extend `FIELD_TYPE_SPECS` / `COMMON_FIELD_CONFIG` so `list_field_types` documents them for the AI.

### 2. Validation — `lib/validation.ts` (the core work)
- Make `fieldDefSchema` **recursive** (`z.lazy`) so `group.fields` and `array.item` validate as field specs; enforce the depth cap + the OUT-of-scope rules (no relation nesting, no computed/unique nested, no array-of-array) at **define time**.
- Extend value validation (`valueSchemaFor`): a group value validates each sub-field; an array value validates `length ≤ maxItems` (hard ceiling, see caps) then each item against `item`.
- This is the biggest single piece — flat → recursive validation.

### 3. Delivery projection — `lib/entries.ts` (`toPublicView`, `publicFields`)
Today (`toPublicView`, L2535) is one flat loop: `if (f.publicRead) out[f.name] = data[f.name]`. Make it **recursive**:
- A group/array field absent `publicRead` → omitted whole (unchanged rule, applied at each level).
- A `publicRead` group → recurse, projecting sub-fields per their own `publicRead`.
- A `publicRead` array-of-group → project each item's `publicRead` sub-fields; array-of-scalar → governed by the array field's `publicRead`.
- **`publicFields()` non-empty check** (drives the collection 404 gate) must treat a collection with only nested public content as exposed.
- Asset resolution (`resolveAssets`) must **recurse** into nested asset sub-fields to emit `{id,url}` (relation resolution is deferred — that's why relations are OUT of v1 nesting).

### 4. Bounds & security — the D4 lesson, non-negotiable
- Per-`array` `maxItems` (author-set) **and a hard ceiling** (propose 200) enforced in validation — an uncapped nested array is the same DoS shape we just closed in query clauses.
- Max nesting **depth** (3) and a per-entry **total-node cap** (propose ~2,000 nested values) so one entry can't balloon the heap on write/project.
- Body size is already bounded (D3 `MAX_DELIVERY_BODY_BYTES`); these add the *structural* bound.

### 5. Query / filter — `lib/query.ts`
No change needed if we hold the line: `where`/`orderBy`/`select` stay **top-level scalar fields only**. Explicitly reject a nested path in filter/sort validation with a clear message. (Deep querying of nested content is a separate, later feature.)

### 6. MCP surface — `lib/mcp/tools.ts`
`define_collection`'s field schema (JSON + the recursive zod in validation.ts) accepts group/array; update the field-type docs so the AI composes them correctly. This is what lets the building agent author a Page collection.

### 7. Admin UI — `components/EntryForm.tsx` + entry create/edit pages (biggest UI lift)
The schema-driven entry form must render **recursively**: a group as a labeled fieldset, an array as add/remove item rows. v1 = add + remove + validation; **reordering is optional** (drag-reorder is the polish, not the MVP). Repeaters are the hardest thing in any CMS admin to render well — budget accordingly.

---

## Open decisions (pick before coding)

1. **`publicRead` cascade (DX).** Recommend: a `publicRead:true` group defaults its sub-fields to public, a sub-field opts out with `publicRead:false`. Without cascade, every page sub-field needs `publicRead:true` (verbose, and an easy footgun given F2). *Recommend cascade.*
2. **Asset nesting in v1.** Recommend **yes** (pages need images; asset resolution recursion is light — resolves to `{id,url}`, no org/publicFilter). Relation nesting stays v2.
3. **Reordering in admin v1.** Recommend **defer** (ship add/remove; add drag-reorder as a fast-follow).
4. **Array-of-scalar vs array-of-group only.** Recommend **support both** (scalar lists like tags are free once the array machinery exists).

---

## Phasing

- **v1 (this plan):** `group` + `array` (scalar/asset items), recursive validation + projection + caps, MCP docs, admin add/remove. Ships page-shaped content.
- **v2:** relation fields inside nested structures (recurse `resolveRelations` with org + F3 publicFilter gating); admin drag-reorder.
- **v3 (only if wanted):** typed-blocks / flexible-content — a discriminated-union array on top of the v1 array primitive. This is the page-*builder*; deliberate, separate bet.

## Effort read

Bigger than any single item this session — it's the CMS core (field model + recursive validation + recursive projection + admin rendering), but **no migration** and **no new infra**. The validation recursion (area 2) and the admin repeater UI (area 7) are the two real cost centers; everything else is mechanical once those land. It unblocks page management **and** gives the SEO agent structured `sections` to read and write.

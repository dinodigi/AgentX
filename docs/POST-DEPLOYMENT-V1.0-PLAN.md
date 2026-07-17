# Post-Deployment v1.0 Plan

**Status:** planning — rooted in the shipped code (file refs throughout).
**Baseline (deployed to pluggie.app, 2026-07-16):** security hardening, styled HTML email, **structured fields** (group/array repeaters, one-level, F2/F3-safe), the **scale layer** (`indexed` fields → expression indexes, index-backed pagination). The data model is now blob-per-entry + declared indexes + relations + one-level repeaters — Dari-shaped, EXPLAIN-verified.
**This plan = the next phase**, in priority order. Cross-project connection is explicitly parked (see end).

**North star:** Pluggie is the **content model / AI-native backend**. The website is built by the customer's AI + frontend on our data. We are not the renderer.

---

## Track 1 — Block types (the cohesive builder) — **PRIORITY 1**

**Gap (from the last update):** `sections` is a repeater of ONE shape. A real page wants a body of **heterogeneous** blocks — hero, features, testimonial, CTA — each with its own fields. This is the "flexible content / typed blocks" tier. It's a **content-model** feature (what Payload/Sanity/Contentful call blocks), NOT a website builder — rendering stays the frontend's job.

**Design — extend the `array` primitive we already shipped.** Today `ArrayField` (`lib/field-types.ts`) is `{ item: ArrayItem; maxItems? }`, where `item` is a scalar spec OR a group. Add a sibling:

```ts
// field-types.ts
interface ArrayField {
  type: "array";
  item?: ArrayItem;            // existing: uniform items (a repeater of one shape)
  blocks?: BlockDef[];         // NEW: heterogeneous typed blocks (exactly one of item|blocks)
  maxItems?: number;
}
interface BlockDef { name: string; label: string; fields: FieldDef[] }
```
Stored value for a `blocks` array: `[{ "_type": "hero", ...heroFields }, { "_type": "features", ... }]` — a discriminated union on `_type`.

**Rides everything structured fields already does — this is the reason we built that first:**
- **Validation** (`lib/validation.ts`): `valueSchemaFor` for an array gains a `blocks` branch → `z.discriminatedUnion("_type", …)`; `walkStructure` validates each block's `fields` and enforces the **one-level rule** (a block's fields are flat + scalar-arrays + relations — a block may not contain another block/repeater-of-groups, per `MAX_ARRAY_GROUP_DEPTH = 1`).
- **Delivery projection** (`lib/entries.ts` `projectStructured`), **write-gate** (`checkFieldWrites`), **nested asset resolution** (`collectAssetIds`/`replaceAssets`) — all recurse per the item's block type; the F2/F3 guarantees hold per block.
- **Visual editor** (`components/StructuredFieldEditor.tsx`): `ArrayEditor` gains an **"+ Add block"** menu (pick a block type) → `NodeEditor` renders that block's `fields`. Reorder/remove already there.
- **MCP** (`lib/mcp/tools.ts`): `define_collection`'s field schema + `list_field_types` docs teach the `blocks` shape so the AI authors page bodies.

**Why first:** it's the missing 20% that makes pages a real builder, it gives the SEO agent richer page structure to read, and it makes packs far more valuable (a pack ships its block types). Bounded — an extension of shipped primitives, no data migration (JSONB).

---

## Track 2 — Packs (plugin + template unified)

**The resolution we reached:** "plugin" and "template" are NOT two systems. There is **one installable unit — a *pack* — carrying any mix of three ingredients:**
1. **Structure** — a declarative spec of collections + fields + relations + workflows + block types.
2. **Tools** — domain verbs that expand what the AI can *do*.
3. **Guidance** — domain AI-context so it customizes/operates faster.

"Template" = a pack heavy on structure; "plugin" = a pack heavy on tools. Same delivery mechanism, one marketplace.

**Key architectural decision (declarative intent, AI-applied — NOT a blind stamp):**
A pack does **not** imperatively stamp collections. It **declares intent + acceptance criteria**, and the **AI realizes it against the actual project** using the existing MCP tools. This:
- **adapts** (merge with existing collections, match naming, add project-specific fields),
- makes **multi-pack projects compose cleanly** — the AI *reconciles* two packs instead of blind stamps colliding,
- is discoverable: **"the AI pings the project, sees the available/enabled packs, and draws on them on demand."**

Guardrail: the spec must be a **precise contract with acceptance criteria** (exact entities/relations/workflow states + tests like "a booking must relate to a customer; double-booking rejected"), not vague prose — so a *marketplace* install is reliable, not the AI's mood. Optionally cache a tested "known-good" baseline the AI starts from (reliability + adaptivity).

**Rooted in what exists:**
- **Structure spec** rides the **export/import manifest** — `lib/manifest.ts` (`exportProject`/`importProject`). A pack's structure ingredient is essentially a manifest the AI applies.
- **Tools** ride the **MCP tool surface** — `TOOL_DEFS` + `callTool` (`lib/mcp/tools.ts`). This is the deferred **Phase 21 / plugins** work (`ROADMAP.md` "ON HOLD"; V0/V1 in `docs/LAUNCH-PLAN.md`) — packs are that, unified with templates.
- **Multi-pack per project** — a project stacks many packs; needs per-project **pack enablement** (a new table + admin surface) and **namespacing** (a pack's collections are prefixed / the AI reconciles) so two packs don't collide.

**Phasing:** (a) pack format = {structure-spec, tools, guidance, acceptance-criteria}; (b) install = AI applies the spec (adaptive) with the manifest as the known-good baseline; (c) per-project enablement + the gallery; (d) authoring (the AI composes a pack from a project — `exportProject` is the seed).

---

## Track 3 — SEO agent (the first tool-pack)

The platform's first pack, tool-heavy — it proves the pack model on real content. Concretely (see the SEO walkthrough): an autonomous agent that runs **audit → scorecard (evidence) → fix → re-score**, operating on the **content layer** (the `seo` group + block-type page structure), reaching into data via relations.

**Toolkit is ~80% existing MCP:** `query_entries`, `list_collections`, `get_project_info` (read), `update_entry` + `define_collection` (write the `seo` fields / add an `seo` group). **Net-new SEO tools:** `fetch_page` (crawl the live `<head>` — advisory), `score_page`, `generate_jsonld`, optional Lighthouse/CWV.

**Phases:** v1 advisor (audit + scorecard, read-only) → v2 operator (apply fixes behind a confirm step — the "hard-to-reverse → confirm" discipline from the security work). **Companion:** a frontend SDK helper (e.g. Next.js `generateMetadata()` reading the `seo` group) so a fixed field actually renders as a meta tag — that closes the loop from "we fixed the data" to "the page ranks."

Depends on: block types (richer page structure) + the pack model (Track 2).

---

## Parked — cross-project connection (a product PATH, not a feature)

Connecting Project A ↔ B (a suite of internal apps that talk) is **parked** because it's a different **product path**, not a bolt-on:
- **Isolated projects** — hard tenant walls, per-project billing/data-plane. (Today.)
- **Connected cluster** — billed as a **workspace**, projects share a data plane and communicate.

And note: **multi-pack projects (Track 2) already deliver the integrated-suite need for most cases** — HR + Sales + Finance as *packs in ONE project* are one tenant, so they relate/communicate freely (relations + events) with no cross-project machinery. Cross-project stays only for the true-isolation case. The trust boundary, when it's built, is the **workspace** (`db/schema.ts` `project_members` / `workspaces`). Revisit deliberately with a pricing decision.

---

## Sequence & effort

1. **Block types** — bounded extension of shipped structured fields; no migration. Highest leverage now.
2. **Packs** — medium; rides the manifest + MCP surface; the format + AI-applied-spec + enablement are the real build.
3. **SEO agent** — mostly existing tools + a few new; proves the pack model.
4. **Cross-project** — parked pending a product-path/pricing decision.

**Touch points (Track 1, ready to spec first):** `lib/field-types.ts` (`blocks` on ArrayField), `lib/validation.ts` (discriminated-union value schema + walkStructure), `lib/entries.ts` (projection/write-gate/asset recursion per block), `components/StructuredFieldEditor.tsx` (Add-block menu), `lib/mcp/tools.ts` (define_collection docs), `scripts/smoke/*` (block-type tests).

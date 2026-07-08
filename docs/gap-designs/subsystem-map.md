## data-core
DATA MODEL: Tables (db/schema.ts): projects (id, name, branding JSONB {displayName,logoUrl,primaryColor}, webhookSigningSecret) L34; project_tokens (SHA-256 tokenHash, unique idx, scope='mcp', lastUsedAt ≤5-min granularity) L48; collections L71 — per-project unique (projectId,name), fields JSONB FieldDef[], publicWrite bool (form = public-write collection), webhookUrl, publicFilter JSONB WhereItem[] (row visibility for delivery), access JSONB {read: public|authenticated|owner, write: none|authenticated|owner, ownerField}, events JSONB {created/updated/deleted: EventAction[]} where EventAction = webhook{url}|email{to,subject} + {when?: WhereItem[], disabled?} (L17-27); entries L110 — data JSONB Record<string,unknown> keyed by field name, idempotencyKey text with partial unique index (collectionId,idempotencyKey) WHERE NOT NULL (L130-132), handledAt; project_members (role operator|client); project_connectors (type clerk|resend, config JSONB non-secret, secretEnc AES-256-GCM); webhook_deliveries (outcome log); audit_log (collectionName, entryId, action, actor JSONB AuditActor mcp|admin|delivery|unknown, changedFields[]) L200; assets (R2 key + url). Entry JSONB values: text/richtext=string, number=number, boolean=bool, date=ISO string, enum=option string, asset=asset uuid, relation=target entry uuid. Relation/asset values are rewritten in-place to {id,label}/{id,url} only at read-resolution time, never stored that way. Per-collection unique fields = dynamically-created partial unique indexes `entries_uq_<8hexOfCollId>_<field>` ON entries((data->>'f')) WHERE collection_id=… (lib/collections.ts:236-274).
KEY FUNCTIONS:
- 8 field primitives: FIELD_TYPES text|richtext|number|boolean|date|enum|asset|relation — lib/field-types.ts:7-16; FieldDef union L77-85; machine-readable specs FIELD_TYPE_SPECS L92 + COMMON_FIELD_CONFIG L119 (served verbatim by list_field_types)
- Meta-schema fieldDefSchema (per-def superRefine: enum needs options, relation needs targetCollection+labelField, unique only text/number, min/max only text/richtext/number) — lib/validation.ts:38-93; fieldsSchema (dupes, requiredIf must target sibling enum option) L96-123; reserved collection names L126-140
- buildEntrySchema(fields, partial) — compiles fields[] to strict Zod (unknown keys rejected, no coercion); partial=true for updates (required only on create); requiredIf superRefine create-only; returns refChecks for relation/asset — lib/validation.ts:198-236; valueSchemaFor per-primitive L148-177
- verifyRefs — batched DB existence checks: one query for all assets, one per target collection for relations — lib/entries.ts:29-97
- createEntry — validate → verifyRefs → insert with idempotencyKey; conflict on entries_idempotency_idx = replay, returns existing row (L169-179); other 23505 → rethrowUnique maps entries_uq_… to 'value already exists' ValidationError (L120-126) — lib/entries.ts:128-180
- updateEntry — partial validate, fetch current, shallow merge {...current.data,...patch}, update; defer(emitEntryEvent) + recordAudit — lib/entries.ts:182-228
- updateEntryIf (CAS) — one SQL UPDATE; if-conditions + increment min/max guards live in WHERE; increment via jsonb_set from old value; returns {ok:false, reason: conflict|not_found} — lib/entries.ts:250-326
- deleteEntry — lib/entries.ts:328-348; bulkCreateEntries (≤100, per-item results, one multi-row insert) L386-438
- queryEntriesPage — limit+1 hasMore, default (createdAt ms-truncated, id) total order, keyset cursor encode/decodeCursor L450-472, cursor incompatible with orderBy — lib/entries.ts:488-518; aggregateEntries (count/sum/avg/min/max, groupBy enum|relation, MAX 500 groups) L644-741
- resolveRelations/resolveAssets/resolveRefsForRead — batched {id,label}/{id,url} resolution — lib/entries.ts:532-620; toPublicView (per-field publicRead projection) L768-774; publicFields L777
- defineCollection — name+fields meta-validation, publicFilter/access/events validation (validateAccessAndEvents L94-138), relation target existence, destructive gate: diffFields L151 + countEntriesWithKeys L218 → {applied:false, requiresConfirmation, diff, hint} unless confirm (L321-328); syncUniqueIndexes BEFORE upsert for existing collections (L335); declared renames backfilled atomically via jsonb key-move UPDATE (L372-378) — lib/collections.ts:286-382
- Collection metadata cached cross-request via unstable_cache + revalidateTag('collections:<projectId>'); entries NEVER cached — lib/collections.ts:18-56
- planDeleteCollection (entryCount + inbound relations) L391-416 / deleteCollection (drops orphaned unique indexes) L419-427
EXTENSION POINTS:
- New field constraint knob: add to FieldBase (lib/field-types.ts:21-44) + fieldDefSchema superRefine (lib/validation.ts:59-93) + valueSchemaFor runtime enforcement (lib/validation.ts:148-177) + document in FIELD_TYPE_SPECS/COMMON_FIELD_CONFIG (lib/field-types.ts:92-123)
- New field primitive: FIELD_TYPES (lib/field-types.ts:7) + interface + FieldDef union (L77) + valueSchemaFor case (lib/validation.ts:149) + FIELD_TYPE_SPECS entry (lib/field-types.ts:92)
- Version-snapshot hook: updateEntry already fetches the pre-image `current` (lib/entries.ts:193-204) and deleteEntry gets the deleted row via .returning() (lib/entries.ts:333-336) — a snapshot write slots beside recordAudit (lib/entries.ts:219, 340) or inside lib/audit.ts recordAudit itself (called from every mutation path incl. updateEntryIf L317 and bulkCreate L427); note updateEntryIf lacks a pre-image (single-statement CAS) — would need RETURNING of old data or a preceding read
- Cross-field/collection-level constraints: define-time validation hooks in defineCollection after validateFieldDefs (lib/collections.ts:291-295); write-time enforcement in validate() (lib/entries.ts:99-111) or as extra superRefine in buildEntrySchema (lib/validation.ts:219-233)
- New collection-level declarative behavior (like events/access): new JSONB column on collections (db/schema.ts:71-107), plumb through DefineCollectionInput (lib/collections.ts:58-89), validate in validateAccessAndEvents pattern (lib/collections.ts:94), persist in defineCollection values+onConflict set (lib/collections.ts:337-365)
- Side-effects on mutation: defer(() => emitEntryEvent(...)) call sites in create/update/updateIf/delete/bulk (lib/entries.ts:156, 216, 316, 339, 426) — lib/events.ts emitEntryEvent is the fan-out point
- transact([ops]) (planned ladder rung): would compose validate/verifyRefs per op then a single db transaction; natural home lib/entries.ts alongside updateEntryIf
INVARIANTS:
- Every write path (MCP, admin, delivery, bulk) goes through buildEntrySchema strict parse + verifyRefs — one definition of 'valid'; unknown keys always rejected, no type coercion (lib/validation.ts:216)
- Per-field publicRead is the only delivery projection — toPublicView never leaks non-publicRead fields (lib/entries.ts:768-774)
- unique fields are DB-enforced via partial unique indexes, not app-level checks — concurrent writers cannot race validation; schema never claims a constraint the DB doesn't hold (index synced BEFORE persisting the definition, lib/collections.ts:330-335)
- Destructive redefinition (drop/retype) always returns a plan and requires confirm: true; renames are the non-destructive path with atomic data backfill (lib/collections.ts:313-328, 372-378)
- Idempotency replay vs unique-violation are distinguishable: explicit conflict handling, never onConflictDoNothing (lib/entries.ts:139-152)
- updateEntryIf conditions + increment bounds evaluate inside the UPDATE's WHERE — atomicity via row serialization, never read-modify-write (lib/entries.ts:265-297)
- Entries are never cached; only collection metadata, tag-revalidated on every definition write (lib/collections.ts:11-18, 380)
- ValidationError messages double as fix hints and carry an ErrorCode (lib/validation.ts:28-35); DB unique violations are translated to agent-repairable messages (lib/entries.ts:120-126)
- sql.raw is used only with meta-validated identifiers (snake_case field names, DB-generated uuids, enum-checked fn names) — no user-controlled raw SQL (lib/collections.ts:256-262, lib/entries.ts:670)
GOTCHAS:
- required and requiredIf are CREATE-only; updates (partial=true) can never fail required-ness, and a patch can't be forced to keep a conditional field populated (lib/validation.ts:204, 219-226)
- updateEntry does a SHALLOW merge of data — there is no way to unset a key via update (undefined keys are stripped by Zod; null fails type validation) (lib/entries.ts:204)
- Idempotency key uniqueness is scoped per COLLECTION, not per project; replay lookup assumes opts.idempotencyKey is set when insert returned nothing (non-null assertion, lib/entries.ts:175) — an unexpected non-idempotency conflict without a key would throw on undefined lookup only after rethrowUnique already filtered, so safe in practice but fragile if new entry-level unique constraints are added outside entries_uq_/entries_idempotency_ naming
- Cursor pagination requires the default ordering; createdAt is ms-truncated on BOTH sides because JS Date loses Postgres microseconds — any new ordering must preserve a shared-precision total order (lib/entries.ts:499-511)
- unstable_cache serializes rows to JSON — timestamps must be revived (lib/collections.ts:21-27); any new Date/complex column on collections needs the same treatment
- syncUniqueIndexes uses sql.raw DDL — safe only because field names pass NAME_RE meta-validation; enabling unique on a field with existing duplicates fails with a dedupe hint, and the definition is intentionally NOT saved in that case
- Unique partial indexes outlive collection cascade-delete; deleteCollection drops them explicitly — forget this in any new delete path and orphaned indexes accumulate (lib/collections.ts:424-425)
- renames cannot retype and cannot add unique in the same call (lib/collections.ts:204-213); rename backfill overwrites any existing value at the target key
- bulkCreateEntries: one unique violation fails the WHOLE valid batch (single multi-row insert), unlike per-item validation errors (lib/entries.ts:410-421); no idempotencyKey support on bulk
- updateEntryIf 'conflict' is also returned when an increment would violate min/max — callers can't distinguish precondition-failed from bounds-exceeded (lib/entries.ts:292-296, 310-312)
- resolveRelations/resolveAssets mutate row.data in place — resolved rows must not be re-validated or re-stored (values become objects, lib/entries.ts:563, 602)
- audit/event emission uses defer() (after-response side work) — a crash after the write can lose the audit row / event; recordAudit for createEntry is not awaited

## query-delivery
DATA MODEL: Single `entries` table (db/schema.ts): id uuid, collectionId, data JSONB, createdAt/updatedAt. All field values live in `data` keyed by field name; typed access is via `data->>'name'` with per-type casts (::numeric / ::timestamptz / ::boolean). Collection row carries `fields: FieldDef[]` (each with `publicRead` boolean), `publicWrite`, `publicFilter: WhereItem[] | null` (declarative row gate), and `access: {read, write, ownerField}` for identity rules.
KEY FUNCTIONS:
- buildWhere — validates WhereItem[] (AND of clauses / one-level anyOf OR groups) against FieldDef[] and compiles to Drizzle SQL[]; lib/query.ts:73
- compileClause — per-op SQL: eq (typed), contains → ILIKE %v%, gt/lt (numeric or ::timestamptz), in → IN list; all values parameterized; lib/query.ts:91
- OPS_BY_TYPE — operator whitelist per field type (text: eq/contains/in; number/date: eq/gt/lt; enum: eq/in; relation: eq/in; richtext: contains; boolean/asset: eq); lib/query.ts:36
- accessor — JSONB text accessor with type cast; shared by where and orderBy; lib/query.ts:58
- matchesClauses — JS-side mirror of buildWhere semantics for single-entry row gates; lib/query.ts:133
- buildOrderBy — validated field + asc/desc, NULLS LAST, dir via sql.raw only after validation; lib/query.ts:176
- queryEntriesPage — limit clamp (1..MAX_QUERY_LIMIT=500), offset, limit+1 fetch for exact hasMore, default total order (date_trunc-ms createdAt, id), keyset cursor via opts.after (rejects orderBy+cursor combo); lib/entries.ts:488
- encodeCursor/decodeCursor — base64url {t,id}; lib/entries.ts:450
- toPublicView — projects entry.data to id + publicRead fields only; lib/entries.ts:768
- publicFields — publicRead filter; empty ⇒ collection not exposed; lib/entries.ts:777
- resolveRefsForRead — resolves relations to {id,label} and assets, batched in one query per kind; lib/entries.ts:610
- GET list handler — token→project resolve, publicFields 404 gate, gateRead identity gate, ?select validation, query-param eq filters restricted to public fields, sort=field:dir, composes effectiveWhere = publicFilter + ownerClause + user filters; app/api/v1/[collection]/route.ts:39
- effectiveWhere composition (order matters: publicFilter, ownerClause, user where); app/api/v1/[collection]/route.ts:104
- POST create — gateCreate, per-IP rateLimit, stampOwner from verified JWT; app/api/v1/[collection]/route.ts:133
- single GET — UUID regex pre-gate, owner + publicFilter checks via matchesClauses, misses are 404 (never confirm existence); app/api/v1/[collection]/[id]/route.ts:40
- PATCH/DELETE — gateMutate (write:'owner' only), ownerField stripped from body; app/api/v1/[collection]/[id]/route.ts:66,105
- cachedJson — sha256-based strong ETag (32 hex), cache-control: no-cache, If-None-Match by substring inclusion (CDNs mutate ETags) → 304; lib/delivery-http.ts:44
- deliveryError — {error, code} envelope, status→ErrorCode map; lib/delivery-http.ts:30
- gateRead/gateCreate/gateMutate/stampOwner — public|authenticated|owner rules, ownerClause for list scoping; lib/access-rules.ts:27,56,85,106
- CORS_HEADERS — wildcard origin (bearer auth, no cookies), exposes etag/retry-after; lib/cors.ts:7
EXTENSION POINTS:
- New where operators: add to WHERE_OPS + OPS_BY_TYPE + compileClause + matchClause (both SQL and JS sides must stay in sync); lib/query.ts:13,36,91,145
- Search: a cross-field `q` param would slot in as another effectiveWhere item built over publicFields only — hook at the query-param loop (app/api/v1/[collection]/route.ts:77) and compile as an anyOf of contains clauses via buildWhere (lib/query.ts:73); for real FTS, add a tsvector expression alongside accessor (lib/query.ts:58)
- Expand (deep relation resolution): extend resolveRefsForRead / resolveRelations — currently resolves to {id,label} via labelField in one batched query; an ?expand=field param would deepen that projection, but expanded rows must pass through the TARGET collection's toPublicView to keep per-field publicRead intact; lib/entries.ts:610,532
- Change feed: no updatedAt exposure or event log in delivery today; natural hook is a gt filter on a system timestamp — either whitelist updatedAt as a pseudo-field in the GET filter loop (app/api/v1/[collection]/route.ts:77) plus an accessor branch for entry columns (lib/query.ts:58), or read from the events emit point in lib/entries.ts (createEntry/updateEntry actor plumbing already exists). Polling + ETag 304 (lib/delivery-http.ts:44) is the host-agnostic transport
- Cursor pagination on delivery: queryEntriesPage already supports keyset cursors (lib/entries.ts:502) and encodeCursor exists (lib/entries.ts:450), but the HTTP route only passes limit/offset and drops hasMore — exposing ?after= and {data, nextCursor} is a small change at app/api/v1/[collection]/route.ts:109
- New list query params: the param loop treats every non-reserved key as an eq filter; reserved names live in the skip list at app/api/v1/[collection]/route.ts:78 — any new param (q, expand, after, since) must be added there or it 422s as an unknown filter field
- Response shaping: ?select projection logic at app/api/v1/[collection]/route.ts:113 is the pattern for further projections
INVARIANTS:
- Per-field publicRead is enforced at three layers and none may weaken: filter/sort/select fields validated against publicFields (route.ts:65,79,93), effectiveWhere validated by buildWhere against schema, and output projected by toPublicView — data never leaves except through toPublicView
- Filtering/sorting restricted to PUBLIC fields specifically because filtering on a private field leaks contents through result differences (route.ts:74 comment)
- All where/orderBy values are parameterized; the only sql.raw is the pre-validated asc|desc direction (lib/query.ts:184) — no raw SQL escape hatch
- Zero public fields ⇒ collection is 404, not an empty list (route.ts:50)
- Row gates (publicFilter + ownerClause) are prepended to every list query and re-checked JS-side (matchesClauses) on single-entry reads; misses return 404, never 403, so existence is never confirmed
- Pagination requires a total order: default (date_trunc-ms createdAt, id), explicit orderBy always tie-broken by id (lib/entries.ts:515); cursor + custom orderBy is rejected
- Owner stamping comes only from the verified JWT (stampOwner) and ownerField is stripped from PATCH bodies — ownership is unforgeable and immutable via delivery
- Every delivery response carries CORS_HEADERS and every error the {error, code} envelope with a stable ErrorCode
- hasMore is exact (limit+1 fetch), never a guess
GOTCHAS:
- matchesClauses and buildWhere are parallel implementations of the same semantics — any new operator or type-coercion change must land in both or list vs single-entry gating diverges (lib/query.ts:73 vs 133)
- matchClause returns false for unknown fields instead of throwing (unlike SQL path) — a typo'd publicFilter silently 404s single reads while buildWhere would 422 the list
- ETag comparison is `includes(hash)` not equality because Netlify appends -df and proxies add W/ — keep this if adding conditional-request features (lib/delivery-http.ts:51)
- cache-control is no-cache (always revalidate), not max-age — the 304 saves body bytes only
- GET list ignores queryEntriesPage's hasMore and MAX_QUERY_LIMIT clamp is silent — a ?limit=1000 quietly returns 500 rows with no signal
- Delivery list filters are eq-only (query params); the richer WhereItem grammar (contains/gt/lt/in/anyOf) is only reachable via publicFilter and the MCP tools, not the public URL surface
- Cursor timestamps are ms-truncated on both sides (date_trunc) — do not compare raw createdAt against a cursor key
- coerceParam (route.ts:127) coerces number/boolean from the query string; anything else stays a string — date filters via URL rely on ::timestamptz cast in compileClause
- Rate limiting exists only on POST, not GET; single-entry routes 404 non-UUID ids before any DB touch (routes to /uploads land here)
- resolveRefsForRead mutates rows in place and runs before toPublicView — expanded relation labels are visible only if the relation field itself is publicRead

## mcp-surface
DATA MODEL: No tables owned here. Tools operate over: collections (per-project rows with JSONB fields[], publicWrite, webhookUrl, publicFilter, access {read,write,ownerField}, events {created|updated|deleted}), entries (JSONB data keyed by field name; unique fields enforced via partial unique indexes named entries_uq_&lt;8-hex-uuid&gt;_&lt;field&gt;, lib/collections.ts:236), assets, deliveries (event log incl. email rows url="email:&lt;to&gt;"), audit log (keys on collection SLUG so rows outlive the collection — tools.ts:1096), tokens (scope: mcp vs delivery).
KEY FUNCTIONS:
- TOOL_DEFS — the full inventory of 26 tools (lib/mcp/tools.ts:83): get_project_info, list_connectors, list_field_types, define_collection, list_collections, describe_collection, delete_collection, create_entry, update_entry, update_entry_if (CAS), delete_entry, query_entries, get_entry, count_entries, aggregate_entries, bulk_create_entries, list_assets, delete_asset, export_entries, export_project, import_project, get_deliveries, get_client_code, refire_delivery, get_audit_log, upload_asset
- callTool(projectId, name, rawArgs, ctx) — single switch dispatcher, never throws; catch maps ZodError→E_VALIDATION via formatZodError, ValidationError→its own code, else E_INTERNAL (lib/mcp/tools.ts:646, catch at 1136-1140)
- ok()/err() result shapers — err renders `Error [CODE]: message` (lib/mcp/tools.ts:627-632)
- mustCollection() — throws ValidationError E_NOT_FOUND for unknown collections (lib/mcp/tools.ts:634)
- POST /api/mcp — JSON-RPC subset: initialize, notifications/*, ping, tools/list, tools/call; bearer token resolves projectId, scope must be 'mcp' else 401 E_SCOPE (app/api/mcp/route.ts:33-88)
- GET /api/mcp — liveness/self-description: tool names + full ERROR_CODES map (app/api/mcp/route.ts:92-103)
- diffFields(oldFields, newFields, renames) — schema diff engine: added/removed/retyped/renamed; rename froms/tos excluded from removed/added (lib/collections.ts:151)
- defineCollection — computes diff + affectedEntries (countEntriesWithKeys, lib/collections.ts:218); destructive (removed/retyped) without confirm returns {applied:false, diff, hint} (lib/collections.ts:286, 312-326)
- validateRenames — same-type only, no unique-add in same call, machine-readable messages (lib/collections.ts:173)
- planDeleteCollection — entryCount + inboundRelations; delete blocked E_BLOCKED while relations target it (lib/collections.ts:391, tools.ts:767-791)
- ERROR_CODES — 11 append-only codes, each value is the fix-hint doc string (lib/error-codes.ts:7-25)
- formatZodError — 'path: message; …' flattening (lib/validation.ts:239)
EXTENSION POINTS:
- New tool = 3 steps: append a ToolDef to TOOL_DEFS (lib/mcp/tools.ts:83) with description stating boundaries + JSON inputSchema; add a case to callTool's switch (lib/mcp/tools.ts:653) parsing rawArgs with a local zod schema; add any new ErrorCode to ERROR_CODES (lib/error-codes.ts:7). No registration elsewhere — route.ts serves TOOL_DEFS directly (app/api/mcp/route.ts:74)
- Shared where-clause vocabulary: WHERE_CLAUSE_JSON/WHERE_ITEM_JSON (lib/mcp/tools.ts:59,71) + whereItemSchema zod twin (lib/mcp/tools.ts:556) — reuse for any new filter-shaped input (query, publicFilter, events.when, update_entry_if.if all share it)
- Confirm/plan pattern to copy: define_collection returns {requiresConfirmation:true, code:'E_CONFIRM_REQUIRED', plan, hint} as an ok() payload, not isError (lib/mcp/tools.ts:724-731); delete_collection same shape (tools.ts:781-788); import_project appends code to result (tools.ts:999)
- BOUNDARIES constant appended to schema-shaping tool descriptions (lib/mcp/tools.ts:46) — extend it when the capability boundary moves
- ToolContext carries baseUrl for URL construction (lib/mcp/tools.ts:641) — add fields here for new per-request context
- Declarative behaviors hook: events schema in defineArgs (lib/mcp/tools.ts:584) + eventActionSchema union (tools.ts:565) — new action types extend that union
- New JSON-RPC methods (e.g. streaming/resources) go in route.ts switch (app/api/mcp/route.ts:57)
INVARIANTS:
- Strict validation everywhere: every tool zod-parses rawArgs; entry data validated against collection schema in lib/entries (unknown fields, wrong types, dangling refs rejected); no raw SQL escape hatch
- Error format is stable: `Error [E_*]: message` with fix hint in the message; ERROR_CODES are append-only — never rename/reuse (lib/error-codes.ts:4-5)
- Destructive = plan + confirm: dropped/retyped fields and collection deletes return a counted plan and require confirm:true; renames via renames[] are non-destructive (data backfilled)
- callTool never throws — all failures become ToolResult with isError (lib/mcp/tools.ts:640,1136)
- Secrets never cross MCP: list_connectors returns non-secret config only; connecting/rotating is operator-side (tools.ts:94-99)
- Token scoping: MCP requires mcp-scoped token; delivery tokens get 401 E_SCOPE (route.ts:42-47)
- One stateless server for all projects — bearer token scopes every request; no session state
- publicRead is per-field, publicWrite/access per-collection; MCP reads bypass publicFilter but never bypass validation
GOTCHAS:
- TOOL_DEFS inputSchema (hand-written JSON Schema) and the zod parse schemas are maintained SEPARATELY — they can drift; keep both in sync when adding/changing a tool
- Confirm-required responses are ok() payloads with code:'E_CONFIRM_REQUIRED', NOT isError results — agents must check the body, not just isError
- query_entries: cursor and offset are mutually exclusive (E_VALIDATION, tools.ts:850); nextCursor only emitted when orderBy is absent (keyset paging rides the default ordering, tools.ts:878)
- select projection is applied BEFORE relation resolution so unselected relations cost nothing (tools.ts:863-866)
- get_audit_log with an unknown collection slug is NOT an error — slugs outlive collections (tools.ts:1096-1097)
- delete_collection checks inbound relations BEFORE the confirm gate — E_BLOCKED wins over E_CONFIRM_REQUIRED (tools.ts:773)
- Notifications (notifications/initialized|cancelled) must return 202 with empty body, not a JSON-RPC result (route.ts:66-68)
- get_client_code output is a schema snapshot — must be regenerated after any define_collection change (description says so; nothing enforces it)
- list-style tools fetch limit+1 rows to compute hasMore — copy that idiom for new paginated tools (e.g. tools.ts:960-961)
- defineArgs uses z.array(z.any()) for fields — field-level validation happens deeper in defineCollection, so zod errors won't catch bad field defs at the tool layer

## events-webhooks (event model, webhook/email actions, delivery log, audit trail, defer)
DATA MODEL: webhook_deliveries (db/schema.ts:180-197): id uuid, projectId FK cascade, collectionId, url text (emails logged as "email:<to>"), event text ("entry.created|updated|deleted"), payload jsonb (full delivery body; for emails includes `email:{to,subject,text}` rendered copy), status text "success"|"failed", attempts TEXT (string, e.g. "3"), lastError text|null, createdAt; index on projectId only. audit_log (db/schema.ts:200-215): id, projectId FK cascade, collectionName text (name, not FK — survives collection deletes), entryId uuid, action "create|update|delete", actor jsonb AuditActor ({type:"mcp"}|{type:"admin",userId?}|{type:"delivery",userSub?}|{type:"unknown"}, schema.ts:218-222), changedFields jsonb string[]|null, createdAt; composite index (projectId, createdAt). Event config lives on collections.events jsonb (schema.ts:98-102): {created?/updated?/deleted?: EventAction[]}; EventAction (schema.ts:25-27) = {type:"webhook",url} | {type:"email",to,subject} plus shared base {when?: WhereItem[], disabled?: boolean}. projects.webhookSigningSecret (schema.ts:40) signs outbound webhooks. Legacy collections.webhookUrl still fires as implicit created-webhook.
KEY FUNCTIONS:
- emitEntryEvent (lib/events.ts:23) — THE single emit point; filters actions by disabled + `when` clauses (evaluated via matchesClauses against the POST-change snapshot, events.ts:33-38), computes changedFields by JSON.stringify diff when previous provided (events.ts:41-46), fans out via Promise.allSettled to deliverWebhook or sendEmailAction
- deliverWebhook (lib/webhook.ts:16) — 3 attempts with in-process backoff [0,1000,3000]ms, 10s timeout each; Stripe-style HMAC header x-agentx-signature: t=<unix>,v1=HMAC_SHA256(secret, `${t}.${body}`) (webhook.ts:38-43); ALWAYS logs one webhook_deliveries row win or lose (webhook.ts:51,59)
- sendEmailAction (lib/events.ts:75) + interpolate (events.ts:69) — {{field}}/{{id}} template rendering; body is fixed JSON dump of entry data
- dispatchEmail (lib/events.ts:102) — Resend connector (key via connectorSecret, from via connector.config.fromEmail), 10s timeout, logs rendered email inside payload so refire replays verbatim
- refireDelivery (lib/events.ts:155) — replay by delivery id: email rows re-send stored render, webhook rows get a fresh 3-attempt cycle; outcome is a NEW log row, original kept
- listDeliveries (lib/webhook.ts:72) / listAuditLog (lib/audit.ts:44) — filtered newest-first pages, limit+1 probe row, tiebreak desc(id)
- recordAudit (lib/audit.ts:12) — one row per mutation, deferred, swallows errors
- defer (lib/defer.ts:11) — Next after() so serverless freeze can't drop side-work; falls back to void-promise outside request scope (tests/scripts)
- Call sites: lib/entries.ts:156,216,316,339,426 — create/update/CAS-update/delete/bulk-create each defer(emitEntryEvent) + recordAudit; consumers: MCP tools lib/mcp/tools.ts:1020,1080,1098; admin settings app/admin/[projectId]/settings/actions.ts:40-42; entry page audit app/admin/[projectId]/[collection]/[entryId]/page.tsx:47
EXTENSION POINTS:
- New action types: add variant to EventAction union (db/schema.ts:25-27) + a branch in the emitEntryEvent dispatch ternary (lib/events.ts:54-64)
- New event payload fields: single payload construction at lib/events.ts:47-51 (already carries entry, previous.data, changedFields on updates — a change-feed row is essentially this payload persisted)
- Durable queue / async delivery: swap the in-request retry loop in deliverWebhook (lib/webhook.ts:34-58) for enqueue; webhook_deliveries is already the natural job table (add nextAttemptAt + status='pending' — attempts column would need int migration)
- Version history: recordAudit (lib/audit.ts:12) is the hook — add a data snapshot column to audit_log; changedFields already computed at lib/entries.ts:216-227 for updates
- Refire/replay surface: refireDelivery (lib/events.ts:155) is the generic replay entry point for any logged delivery kind
- Fan-out to new surfaces: emit is guaranteed single-point — anything routed through lib/entries.ts inherits events + audit for free
INVARIANTS:
- ALL entry mutations flow through lib/entries.ts, which is the only caller of emitEntryEvent — never emit elsewhere (lib/events.ts:10-19 doc contract)
- Every delivery attempt (webhook or email) ends in a webhook_deliveries row, success or failure — a lost lead must be visible (webhook.ts:6-11)
- Logging/auditing must NEVER take down the mutation path: all log inserts are try/catch-swallowed (webhook.ts:106, events.ts:144, audit.ts:31)
- Events and audit are side-work: always wrapped in defer() so response latency and mutation success are unaffected
- Webhook payloads are signed with projects.webhookSigningSecret when present (freshness via timestamp in signed string)
- Refire creates a new log row; history rows are immutable
- Email renders are stored with the log row so refire never re-derives templates (events.ts:87-92)
GOTCHAS:
- webhook_deliveries.attempts is a TEXT column holding a stringified int (schema.ts + webhook.ts:103) — sort/compare numerically only after cast; a job-queue design should migrate it
- CAS path (update_entry_if) emits 'updated' WITHOUT the previous snapshot (lib/entries.ts:316) — no previous/changedFields in that payload, unlike plain update (entries.ts:217); a change feed built on this payload would have a gap
- `when` clauses evaluate against the post-change snapshot only (events.ts:36-37) — no transition semantics (can't express 'status changed from X to Y'); delete events with when + no entry.data never fire (entry.data falsy → filtered out)
- Retries are in-process sleeps inside the request-scoped after() task — max ~4s backoff + 3x10s timeouts held in one serverless invocation; total failure of the process loses the retry (only the logged row remains, refire is manual)
- changedFields diff uses JSON.stringify per key — key-order-sensitive for nested objects (false positives possible) (events.ts:44)
- Email deliveries reuse the webhook_deliveries table with url='email:<to>' as the discriminator (events.ts:137, refire branch events.ts:166) — any delivery-log consumer must handle both shapes
- defer() outside a request scope silently swallows task failures entirely (defer.ts:15)
- audit_log stores collectionName (text) not collectionId — renaming a collection orphans history under the old name
- Legacy collections.webhookUrl fires an implicit created-webhook with no when/disabled controls (events.ts:30-32)
- No delivery dedup/idempotency key — refire + original both hit the receiver; receivers must dedupe on their side

## auth-connectors: token scopes, end-user JWT (JWKS), rule presets + ownerField, connector model + AES-GCM secrets
DATA MODEL: project_tokens (db/schema.ts:48): id, projectId, tokenHash (SHA-256 hex of raw `agx_`+24B base64url token), scope 'mcp'|'delivery', lastUsedAt — raw token shown once. collections.access JSONB (db/schema.ts:92-96): { read?: 'public'|'authenticated'|'owner', write?: 'none'|'authenticated'|'owner', ownerField?: string }; publicWrite is a separate per-collection boolean (schema.ts:82); publicRead is per-field inside fields JSONB; publicFilter JSONB row gate (schema.ts:86). project_connectors (db/schema.ts:162): one row per (projectId, type), config JSONB (non-secret strings), secretEnc text = AES-256-GCM "iv.tag.ciphertext" each base64url, status 'connected'|'error'. project_members (role 'operator'|'client') backs admin-UI access (lib/access.ts).
KEY FUNCTIONS:
- resolveToken — lib/tokens.ts:33 — hash lookup, unstable_cache tag 'project-tokens' + 5-min TTL defense-in-depth, fire-and-forget lastUsedAt heartbeat on cache miss; MCP route requires scope==='mcp' (app/api/mcp/route.ts:38,98), delivery accepts either scope via resolveProjectId (lib/tokens.ts:61)
- bearerFrom — lib/tokens.ts:66 — Authorization header parse
- verifyEndUser — lib/user-auth.ts:47 — decode untrusted iss to pick issuer from getAuthConfig, then jwtVerify against that issuer's remote JWKS (module-level cache lib/user-auth.ts:12-24, 10-min cacheMaxAge), 30s clockTolerance, optional audience; returns discriminated UserAuthResult ok/none/invalid(reason)/unconfigured
- gateRead — lib/access-rules.ts:27 — read:'public' short-circuits with no auth; 'owner' returns ownerClause {field: ownerField, op:'eq', value: sub} merged into the query
- gateCreate — lib/access-rules.ts:56 — write:'none' falls back to legacy publicWrite; else requires verified user
- gateMutate — lib/access-rules.ts:85 — update/delete only under write:'owner'; non-owner gets 404 (not 403) to avoid existence leak
- stampOwner — lib/access-rules.ts:106 — forces ownerField = user.id on authenticated creates (client cannot spoof)
- getAuthConfig — lib/connectors.ts:155 — Clerk connector config → {issuers[] (primary+additionalIssuers, trailing-slash stripped), jwksUrl = issuer + /.well-known/jwks.json, audience?}
- deriveClerkIssuer — lib/connectors.ts:61 — decodes pk_test_/pk_live_ base64 payload to the frontend-API domain (one-paste connect)
- upsertConnector — lib/connectors.ts:98 — onConflictDoUpdate keeps existing secretEnc when no new secret supplied; revalidateTag connectors:<projectId>
- connectorSecret — lib/connectors.ts:136 — decrypt server-side only, never through tools
- rotateConnectorSecret — lib/connectors.ts:180 — validate-before-save: probes provider (resend: GET /domains) and keeps old key on failure
- checkConnectorHealth — lib/connectors.ts:216 — clerk: fetch JWKS; resend: authed /domains; writes status back
- encryptSecret/decryptSecret — lib/crypto.ts:18/26 — AES-256-GCM, 12B IV, master key from CONNECTOR_MASTER_KEY (32B base64)
- Gate consumers: app/api/v1/[collection]/route.ts:53,143,167; [id]/route.ts:48,76,115; uploads/route.ts:36 — all read X-User-Token header
EXTENSION POINTS:
- New connector type: add to ConnectorType union + CONNECTOR_SPECS (lib/connectors.ts:13-52 — label, configFields, secretLabel); add type-specific branches in rotateConnectorSecret validation (lib/connectors.ts:192) and checkConnectorHealth (lib/connectors.ts:223); UI auto-renders from CONNECTOR_SPECS (app/admin/[projectId]/connectors/page.tsx:29, save action app/admin/[projectId]/settings/actions.ts:157-196). No DB migration needed — type is a text column.
- New rule preset: extend access zod enum in defineArgs (lib/mcp/tools.ts:577-583) + JSONB type (db/schema.ts:92-96) + tool description (lib/mcp/tools.ts:140-152), then implement in gateRead/gateCreate/gateMutate (lib/access-rules.ts:27,56,85). Claims-based presets would extend EndUser.claims (lib/user-auth.ts:29) into new ownerClause-style filters.
- New token scope: TokenInfo union (lib/tokens.ts:25) + scope checks at app/api/mcp/route.ts:38 and delivery resolveProjectId (lib/tokens.ts:61).
- Multi-issuer / other IdPs: getAuthConfig (lib/connectors.ts:155) is the single seam — anything returning {issuers[], audience} plugs into verifyEndUser unchanged.
- Owner-scoped queries: ownerClause from gateRead (lib/access-rules.ts:50) is a plain WhereClause — new row-scoping rules just return different clauses.
INVARIANTS:
- Raw tokens never stored — SHA-256 hash only (lib/tokens.ts:18); revocation must revalidateTag('project-tokens'), TTL 300s is the outside bound.
- Connector secrets never leave the server: list_connectors returns only {type, status} (lib/mcp/tools.ts:704); decryptSecret called only inside connectorSecret at moment of use.
- JWT verification is purely cryptographic — no per-request calls to Clerk; the token's iss claim only selects which JWKS rejects it (lib/user-auth.ts:56-67); sub claim required.
- ownerField is always server-stamped on authenticated creates (stampOwner) — client-supplied value is overwritten; mutation of non-owned rows returns 404, never 403.
- publicRead per-field projection is independent of row gates: access rules gate rows, publicRead gates the projection — neither bypasses the other.
- write:'none' + publicWrite anonymous-form path is preserved exactly (lib/access-rules.ts:63-67).
- Secret rotation never destroys a working key: candidate validated against the live provider first (lib/connectors.ts:180).
GOTCHAS:
- unstable_cache is Next-specific — a Render move must replace both caches (tokens.ts:36, connectors.ts:77) and the revalidateTag invalidation; the JWKS cache (user-auth.ts:12) is plain in-memory and portable but per-instance.
- getAuthConfig returns null if the Clerk connector has no issuer in config — gates then return 503 'unconfigured', not 401.
- Clerk connector stores no secret (secretLabel: null) — issuer/audience are public config; don't add a Clerk secret path assuming symmetry with Resend.
- upsertConnector with empty secret keeps the old secretEnc silently (lib/connectors.ts:120) — 'clearing' a secret requires removeConnector.
- gateMutate checks ownership against the CURRENT entry data passed in (access-rules.ts:98) — callers must load the entry first; an update payload changing ownerField is a separate concern for the caller/validator.
- Trailing slashes on issuers are stripped on both sides (user-auth.ts:57, connectors.ts:157) — keep that normalization if adding issuer sources.
- CONNECTOR_MASTER_KEY missing throws at encrypt/decrypt time, not boot — connector features fail lazily in envs without it.
- Platform ADMIN_EMAILS operators (lib/access.ts:32) bypass project membership entirely — env-var driven, comma-separated, lowercase-compared.

## admin-ui
DATA MODEL: No admin-specific tables. Admin reads: `projects` (branding JSONB: displayName/primaryColor/logoUrl; webhookSigningSecret), `collections` (fields JSONB = FieldDef[] from lib/field-types: text|richtext|number|boolean|date|enum|relation|asset, each with name/label/required/publicRead; collection-level publicWrite/webhookUrl), `entries` (data JSONB keyed by field name; handledAt timestamp = inbox workflow metadata, never part of validated payload), `projectTokens` (hash only, scope mcp|delivery, lastUsedAt), `projectMembers` (email/role client|operator), `webhookDeliveries` (status/event/url/lastError). Relation values render as {id,label} after resolveRefsForRead; asset values as {url}.
KEY FUNCTIONS:
- ProjectLayout — branded shell, access-as-notFound, per-project --brand CSS var, grouped unhandled-inbox counts: app/admin/[projectId]/layout.tsx:17 (safeColor whitelist :78)
- Sidebar — renders nav purely from schema registry: Content (non-publicWrite) / Inbox (publicWrite + badge) / fixed Project tabs (Media, Appearance, Connectors, API, Settings): components/Sidebar.tsx:23 (tab list :121-132)
- CollectionEntries — auto-generated table: first 4 fields as columns (:38), quick-search on first text/richtext field (:26), CSV/JSON export links (:59), handled-toggle chip form (:123): app/admin/[projectId]/[collection]/page.tsx:12
- Cell — type-aware cell renderer, one representation per primitive (boolean chips, enum chip, relation label, date, asset thumbnail, richtext strip+truncate): app/admin/[projectId]/[collection]/page.tsx:192
- EntryForm — the auto-generated form, one input per FieldDef, client component taking a bound server action, per-field public/admin-only VisibilityPill: components/EntryForm.tsx:25; FieldInput switch per type :111 (richtext→RichtextInput, relation→RelationCombobox, asset→AssetInput, enum→select, date→datetime-local via toLocal :206)
- coerceFormData — FormData→typed entry: boolean on/true, number Number(), date→ISO, empty optionals omitted so required-ness is enforced by the validation core, never the UI: lib/admin-form.ts:9
- saveEntry — the canonical entry server action: role check → getCollection → coerce → createEntry/updateEntry with actor {type:'admin',userId}; ValidationError.message returned as {error}, redirect after try/catch: app/admin/actions.ts:18
- toggleHandledAction — workflow metadata toggle, bypasses entry pipeline deliberately (no events, invisible to delivery API): app/admin/actions.ts:55
- getProject — unstable_cache tagged project:{id}, revalidateTag on branding edits: lib/admin.ts:12
- loadRelationChoices — per relation field, loads target collection entries (limit 500) labeled by labelField, parallel: lib/admin.ts:27
- EditEntry page — form + metadata aside (visibility count via publicFields, audit history via listAuditLog): app/admin/[projectId]/[collection]/[entryId]/page.tsx:30
- NewEntry page — same EntryForm with initial={} and saveEntry.bind(...,null): app/admin/[projectId]/[collection]/new/page.tsx:9
- SettingsPage — operator-only (role!=='operator' → notFound): tokens, signing secret, per-collection webhooks, delivery log with re-fire, manifest export, members: app/admin/[projectId]/settings/page.tsx:14
- requireOperator guard used by all settings mutations: app/admin/[projectId]/settings/actions.ts:14
EXTENSION POINTS:
- New field type: add case to FieldInput switch (components/EntryForm.tsx:111), Cell renderer (app/admin/[projectId]/[collection]/page.tsx:195), and coercion (lib/admin-form.ts:25) — three touch points per type
- New sidebar page: add item() call in Project group (components/Sidebar.tsx:127-132) + new app/admin/[projectId]/<name>/page.tsx (siblings: appearance, connectors, api, assets, settings)
- New settings section: add <section> in app/admin/[projectId]/settings/page.tsx:52-181, client component in settings/sections.tsx, server action in settings/actions.ts guarded by requireOperator (:14)
- New entry-level action (bulk ops, status): follow saveEntry pattern in app/admin/actions.ts:18 — role check, go through lib/entries mutators, return {error} / redirect
- List-view features (filters, column picker): where-clause construction at app/admin/[projectId]/[collection]/page.tsx:26-28 and column slice :38
- Relation picker behavior: lib/admin.ts:27 (choices) + components/RelationCombobox.tsx
- Per-entry side panel content: aside in app/admin/[projectId]/[collection]/[entryId]/page.tsx:77-130
INVARIANTS:
- All entry writes go through lib/entries createEntry/updateEntry/deleteEntry with an actor — the admin UI never validates or writes entries.data itself; coerceFormData only coerces, validation core enforces required/types (lib/admin-form.ts:23 comment)
- Per-field publicRead is display-only in the UI (VisibilityPill) — enforcement lives in the delivery layer; admin never toggles it (schema changes are MCP-only)
- Access: every page/action calls getProjectRole; no role → notFound (pages) or {error} (actions); settings requires operator specifically
- Branding color is regex-whitelisted before entering inline style (layout.tsx:78) — no arbitrary CSS from tenant data
- Tokens: only hashes stored, plaintext revealed once at mint (settings/page.tsx:61)
- handledAt is workflow metadata: never in entries.data, fires no events, invisible to delivery API (app/admin/actions.ts:50-54)
- Server actions return {error: string} (never throw to client) and redirect outside try/catch because redirect throws by design (app/admin/actions.ts:46)
GOTCHAS:
- No schema editing in the admin at all — collections/fields are created only via MCP tools; the UI is a pure projection of the registry
- Server actions are bound with .bind(null, projectId, ...) in server components then passed to client components — new actions must follow this or params leak into FormData
- EntryForm is a client component but pages are RSC; relation choices must be preloaded server-side (loadRelationChoices) and passed down — no client fetching
- loadRelationChoices caps at 500 rows per target collection — large collections silently truncate the picker
- Table shows only the first 4 fields (page.tsx:38) and search only hits the first text/richtext field — field order in the schema is UI-significant
- coerceFormData omits empty strings entirely, so clearing an optional field in the edit form does NOT null it out — the key is absent from the update payload (behavior depends on updateEntry merge semantics)
- getProject is unstable_cache'd — branding edits must revalidateTag(`project:${id}`) or the shell shows stale brand
- Two form-error idioms coexist: EntryForm/sections.tsx use useState + action-return {error}; plain <form action> (toggleHandled, refire) are fire-and-forget no-ops on failure
- styling idiom: CSS utility classes (card, btn, chip, field-input, eyebrow, section-label) + --color-* vars + --brand; lucide-react icons; no component library

## infra-ops
DATA MODEL: Neon Postgres via drizzle-orm/neon-http (HTTP driver, no pooling/transaction support in db client — db/index.ts:1-7). 8 tables in db/schema.ts; infra-relevant: `assets` (id uuid, projectId, r2Key, filename, contentType, size stored as String, url, createdAt), `project_tokens` (token_hash sha256, scope 'mcp'|'delivery', last_used_at), `projects` (branding jsonb, webhook_signing_secret), `webhook_deliveries` (status/event/url log), `audit_log` (action, actor, changed_fields, entry_id), `project_connectors` (project_id+type unique, config jsonb, AES-GCM encrypted secrets). No migrations directory exists — schema managed by `drizzle-kit push` only (package.json:12 `db:push`); drizzle.config.ts points out to ./db/migrations but it is empty/unused, so any pg-backed queue table would be added to db/schema.ts and pushed, not migrated.
KEY FUNCTIONS:
- db client: C:\dev\AgentX\db\index.ts:5-7 — neon(DATABASE_URL) + drizzle with full schema; single export `db`
- rateLimit(key): C:\dev\AgentX\lib\ratelimit.ts:45-55 — sliding window 20 req / 60s, returns {allowed, retryAfterSec}; keyed `${projectId}:${ip}` at app/api/v1/[collection]/route.ts:147 and app/api/v1/[collection]/uploads/route.ts:40
- RateLimitStore interface: C:\dev\AgentX\lib\ratelimit.ts:12-20 — single method hit(key, now, windowMs, max) -> {allowed, oldestInWindow}; MemoryStore default at :22-43 (per-lambda on serverless; durable impl explicitly pending per SYSTEM-REVIEW C2)
- uploadAsset: C:\dev\AgentX\lib\r2.ts:38-72 — validates 10MB cap (:35) + content-type prefix allowlist (:36: image/, application/pdf, text/plain, text/csv, application/json), key = projectId/uuid/sanitized-filename, PutObject to R2, inserts assets row with public URL from R2_PUBLIC_BASE_URL
- deleteAsset: C:\dev\AgentX\lib\r2.ts:97-122 — E_BLOCKED if any entry's data::text LIKE contains the asset uuid; then DeleteObject + row delete
- R2 client (lazy singleton): C:\dev\AgentX\lib\r2.ts:15-26 — S3Client region 'auto', endpoint https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com; @aws-sdk/s3-request-presigner is installed but unused (presigned-PUT deferred per SYSTEM-REVIEW 06)
- Clerk middleware: C:\dev\AgentX\middleware.ts:8-19 — protects /admin(.*) only; matcher excludes _next, api/mcp, api/v1, static extensions (those routes are token-authed)
- Security headers: C:\dev\AgentX\next.config.ts:5-22 — X-Frame-Options DENY etc. on non-/api/v1 routes; strict CSP deferred (Clerk inline scripts); serverExternalPackages: @modelcontextprotocol/sdk (:4)
- Smoke harness: C:\dev\AgentX\scripts\smoke\helpers.mjs — BASE = SMOKE_BASE ?? localhost:3000 (:10), createEphemeralProject via direct neon SQL minting agx_ tokens (:30-51), mcp() JSON-RPC caller (:65), delivery() with random x-forwarded-for to decouple rate limiter (:89), startMockIssuer() in-process RS256 JWKS (:110), startWebhookReceiver (:153), waitFor poll (:176). Run: `npm run smoke` = node --test --test-concurrency=1 scripts/smoke/*.test.mjs (16 files, 93 tests); `npm run verify` = tsc --noEmit + smoke
EXTENSION POINTS:
- Durable rate-limit store: swap the const at C:\dev\AgentX\lib\ratelimit.ts:43 (`const store: RateLimitStore = new MemoryStore()`) for a Neon/Upstash impl of the one-method interface at :12-20 — call sites unchanged. Host-agnostic pg-backed impl fits the Render move.
- Rate-limit call sites (public write surface): C:\dev\AgentX\app\api\v1\[collection]\route.ts:147 and ...\uploads\route.ts:40
- Upload type/size policy: C:\dev\AgentX\lib\r2.ts:35-36 (MAX_UPLOAD_BYTES, ALLOWED_TYPE_PREFIXES) — the single choke point for both admin (/api/admin/upload/route.ts:21) and public (/api/v1/[collection]/uploads/route.ts:59) uploads
- Presigned-PUT uploads: presigner dep already in package.json:20; would extend lib/r2.ts alongside uploadAsset
- New tables (e.g. pg job queue): add to db/schema.ts, run npm run db:push — no migration files to author
- Prod smoke: set SMOKE_BASE env (helpers.mjs:10) to point the whole suite at a deployment; note ephemeral-project creation needs DATABASE_URL direct SQL access (helpers.mjs:11)
- Hosting: netlify.toml is 9 lines (npm run build + @netlify/plugin-nextjs); nothing else is Netlify-specific — no vendor cron, no edge config — so Render migration touches only this file + env vars
INVARIANTS:
- Rate limiting guards every public (delivery-token) write path — POST entries and uploads both call rateLimit before doing work
- Asset deletion is blocked while any entry references the asset id (r2.ts:105-116) — no dangling asset refs
- Upload validation (size + content-type allowlist) happens inside uploadAsset, so no caller can bypass it
- /api/mcp and /api/v1 are never Clerk-gated (middleware matcher) — they authenticate by hashed project token; /admin always is
- Smoke tests only ever touch ephemeral projects they create and cascade-delete — safe against real data, safe to run against prod via SMOKE_BASE
- Secrets live in env vars (DATABASE_URL, R2_*, Clerk keys) or encrypted connector config — netlify.toml is committed and carries no env values
GOTCHAS:
- neon-http driver = no interactive transactions; update_entry_if-style atomicity is done via single-statement SQL, and a pg-backed queue must use single-statement claim semantics (e.g. UPDATE ... RETURNING with FOR UPDATE SKIP LOCKED may not work over HTTP driver — verify)
- No drizzle migration files exist despite drizzle.config.ts out dir — db:push is the actual workflow; don't assume a migration history
- MemoryStore rate limiting is per-lambda on serverless: effectively a much looser limit in prod (documented in ratelimit.ts header and SYSTEM-REVIEW C2)
- assets.size is stored as a String, not a number (r2.ts:67)
- Netlify CDN strips If-None-Match, breaking ETag 304s in prod (SYSTEM-REVIEW C2 note) — a Render motivation
- R2 objects are publicly readable via R2_PUBLIC_BASE_URL immediately on upload — no private assets concept yet
- Smoke suite requires a running dev server (ensureServer, helpers.mjs:13) AND direct DATABASE_URL access; it seeds projects via raw SQL, bypassing the API, so schema changes to projects/project_tokens must update helpers.mjs too
- smoke runs with --test-concurrency=1; helpers randomize x-forwarded-for specifically so the shared in-memory rate limiter doesn't couple tests — a durable store impl could reintroduce cross-test coupling if keys change
- deleteAsset reference check is a LIKE on entries.data::text — precise only because asset ids are uuids; a feature storing uuids elsewhere in data could false-positive block deletion
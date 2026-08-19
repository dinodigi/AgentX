import { FIELD_TYPES } from "./field-types";

/**
 * Every number the platform states in public — in ONE place.
 *
 * WHY THIS FILE EXISTS. The marketing site advertised "42 tools" while the MCP
 * surface shipped 61, and "8 field primitives" for the entire life of
 * group/array (which is 10). Neither was a lie anyone told on purpose: each
 * figure was a hand-typed string inside a React component, so shipping a
 * primitive and updating the sentence describing it were separate acts, and the
 * second one silently stopped happening.
 *
 * `lib/field-types.ts` already solved this internally — it is the single source
 * of truth for what a field can be, and a contract test asserts
 * `list_field_types`' description agrees with `FIELD_TYPES.length`, an assertion
 * that "cannot rot" because adding an 11th primitive fails it. That discipline
 * simply stopped at the repo boundary. This file carries it across.
 *
 * THE RULE: a number that appears on a public surface — marketing copy, a docs
 * page, a generated reference — is imported from here. Never typed. If you find
 * yourself writing a digit into JSX or into a doc sentence, the digit belongs in
 * this file instead.
 *
 * TWO KINDS OF FACT LIVE HERE, and the difference matters:
 *
 *  1. DERIVED — computed from the real source (`FIELD_PRIMITIVE_COUNT` counts
 *     FIELD_TYPES). These cannot drift at all; there is no second copy.
 *
 *  2. OWNED — the constant itself lives here and the implementation imports it
 *     (`lib/ratelimit.ts` takes its window and ceiling from this file, rather
 *     than defining them and hoping the copy on the website matches). Inverting
 *     that dependency is what makes this a source of truth instead of a third
 *     duplicate.
 *
 * One figure can be neither: MCP_TOOL_COUNT. The tool registry pulls
 * `server-only` imports, so a statically rendered marketing page cannot import
 * it, and importing the generated contract JSON would ship ~100KB of tool
 * descriptions into the browser to read one integer. So it is stated once here
 * and PINNED TO THE WIRE by a contract test that lists the live tools and
 * compares. Same technique as the primitive count: stated in one place, and the
 * suite fails the moment reality moves.
 */

// ---------------------------------------------------------------- data model

/** The field primitives an author composes schemas from. Derived — cannot drift. */
export const FIELD_PRIMITIVE_COUNT = FIELD_TYPES.length;

/** The two of those that hold nested content rather than a scalar value. */
export const CONTAINER_PRIMITIVES = ["group", "array"] as const;

/** Scalar primitives — the count most marketing copy actually means. */
export const SCALAR_PRIMITIVE_COUNT = FIELD_PRIMITIVE_COUNT - CONTAINER_PRIMITIVES.length;

// ---------------------------------------------------------------- MCP surface

/**
 * Tools exposed over MCP. NOT derived — see the header. Pinned to the wire by
 * the contract suite, so a new tool fails the build until this is updated.
 */
export const MCP_TOOL_COUNT = 61;

// ---------------------------------------------------------------- rate limits
// OWNED here; lib/ratelimit.ts and the MCP route import these rather than
// defining their own. The delivery figure is the one integrators ask about
// first, so a stale copy of it on the pricing page is a support ticket.

/** The rate-limit bucket width, in milliseconds. */
export const RATE_WINDOW_MS = 60_000;

/**
 * Delivery API requests per window, keyed on (project, client IP).
 * Per-IP keying means one misbehaving caller cannot deny service to another —
 * but callers sharing a NAT share a bucket, which is the honest caveat.
 */
export const DELIVERY_REQUESTS_PER_WINDOW = 20;

/** MCP calls per window, keyed per PROJECT — IP-independent, since MCP is trusted. */
export const MCP_CALLS_PER_WINDOW = 300;

/** Derived image transforms per window, per IP. Its own allowance. */
export const IMAGE_TRANSFORMS_PER_WINDOW_PER_IP = 120;

// ---------------------------------------------------------------- convergence
// Two different caches, and conflating them is a documented field failure: a
// tenant measured ~43s against a published "~15s" because that figure named the
// COLLECTION DEFINITION cache while their question was about entry content,
// which is not app-cached at all and is delayed by the edge instead.

/** Collection-definition cache TTL, seconds — governs SCHEMA convergence. */
export const DEFINITION_CACHE_SECONDS = 15;

/** Edge cache TTL, seconds — governs when a cacheable delivery GET refreshes. */
export const EDGE_CACHE_SECONDS = 60;

/** Additional stale-while-revalidate window at the edge, seconds. */
export const EDGE_STALE_WHILE_REVALIDATE_SECONDS = 300;

// ---------------------------------------------------------------- delivery API

/**
 * Distinct delivery endpoints under /api/v1 — pinned to the filesystem by the
 * public-truth suite, which counts route.ts files. The site said 7; there are 9.
 */
export const DELIVERY_ENDPOINTS = 9;

// ---------------------------------------------------------------- test suite

/**
 * A FLOOR, deliberately, rendered with a "+". The site claimed "458 smoke tests"
 * against a suite of ~958 — it had simply stopped being updated, and a precise
 * figure invites exactly that rot because every new test makes it wrong.
 *
 * A floor only ever needs raising, and the suite asserts BOTH directions: the
 * real count must not fall below it (never oversell), and must not exceed it by
 * so much that we are badly underselling again (which is the actual bug here —
 * we were advertising less than half the tests we run).
 */
export const SMOKE_TEST_FLOOR = 900;

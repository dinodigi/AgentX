import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ensureServer, BASE } from "./helpers.mjs";
import { ERROR_CODES } from "../../lib/error-codes.ts";

// CP3 — the documentation an external agent can actually fetch.
//
// Before this the ONLY publicly readable document was the hooks contract, and
// nothing announced even that. "Point your AI at our docs" was a thing we said,
// not a thing the platform supported.
//
// Tested over HTTP rather than by importing the registry, so these assert the
// surface a stranger actually reaches. The security property matters more than
// the feature: `docs/` also holds internal plans, dated reviews and PM state, so
// the interesting assertion is not "the allowlist works" but "everything NOT on
// it is unreachable."

/**
 * The published set, stated here deliberately.
 *
 * Publishing is a decision, so it should take two edits — the registry and this
 * list. A new slug appearing without someone touching this file fails the suite,
 * which is exactly the friction an allowlist over a directory of internal
 * documents should have.
 */
const PUBLISHED = ["hooks", "capabilities", "contract", "contract.json", "limits", "errors"];

describe("public docs: the allowlist publishes, and only what it names", () => {
  before(() => ensureServer());

  const doc = (slug) => fetch(`${BASE}/api/docs/${slug}`);

  it("every published doc resolves and carries real content", async () => {
    for (const slug of PUBLISHED) {
      const res = await doc(slug);
      assert.equal(res.status, 200, `${slug} must resolve`);
      const body = await res.text();
      assert.ok(body.length > 200, `${slug} came back suspiciously short (${body.length} bytes)`);
    }
  });

  it("the JSON contract is served as JSON and parses", async () => {
    const res = await doc("contract.json");
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);
    const parsed = JSON.parse(await res.text());
    assert.ok(Array.isArray(parsed.tools) && parsed.tools.length > 0, "tools[] must be present");
    assert.ok(parsed.errorCodes, "the error registry rides along with the contract");
  });

  it("the published set is EXACTLY what we intend", async () => {
    // The 404 advertises the allowlist, so it doubles as the published index.
    const res = await doc("no_such_doc");
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.code, "E_NOT_FOUND");
    const advertised = body.error.split("available:")[1].split(",").map((s) => s.trim());
    assert.deepEqual(
      advertised.sort(),
      [...PUBLISHED].sort(),
      "the published set changed — confirm the new document is meant to be public",
    );
  });

  it("SECURITY: an internal doc is NOT reachable by guessing a slug", async () => {
    // Every one of these is a real path under docs/. None is published, and none
    // may become reachable because someone added a filesystem fallback.
    for (const slug of [
      "BACKLOG",
      "README",
      "OPS",
      "DESIGN-BRIEF",
      "plans/XVIBE-PLAN",
      "reviews/SECURITY-PASS",
      "pm/STATUS",
      "pm/BOARD",
    ]) {
      const res = await doc(encodeURIComponent(slug));
      assert.equal(res.status, 404, `"${slug}" must not be published`);
    }
  });

  it("SECURITY: traversal cannot escape the allowlist, and errors never echo a file", async () => {
    for (const attempt of ["../.env", "..%2F.env", "../../package.json", "hooks/../../.env"]) {
      const res = await doc(encodeURIComponent(attempt));
      assert.ok(res.status === 404 || res.status === 400, `"${attempt}" must not resolve (got ${res.status})`);
      const body = await res.text();
      assert.doesNotMatch(body, /DATABASE_URL|CLERK_SECRET|sk_test_|sk_live_/, "an error must never echo file contents");
    }
  });

  it("/llms.txt links every published doc and names the entry points", async () => {
    const res = await fetch(`${BASE}/llms.txt`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/plain/);
    const body = await res.text();
    for (const slug of PUBLISHED) {
      assert.match(body, new RegExp(`/api/docs/${slug.replace(".", "\\.")}`), `llms.txt must link ${slug}`);
    }
    assert.match(body, /\/api\/mcp/, "an agent needs the MCP endpoint");
    assert.match(body, /get_project_info/, "…and the tool to call first");
    assert.doesNotMatch(body, /\w\/\/api\//, "URLs must not double up a slash");
  });

  it("the limits reference states the values the platform ENFORCES", async () => {
    const body = await (await doc("limits")).text();
    assert.match(body, /300 per 60s/, "MCP budget, from platform-facts");
    assert.match(body, /20 per 60s/, "delivery budget, from platform-facts");
    assert.match(body, /120 per 60s/, "image transform budget");
    // The most-asked question, and the one I got wrong when answering it by hand.
    assert.match(body, /Plain reads are not rate limited/);
  });

  it("the limits reference IMPORTS its numbers rather than typing them", () => {
    // The point of generating it. A hard-coded budget here would be wrong within
    // a sprint, and would be wrong silently.
    const src = readFileSync("lib/public-docs.ts", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    const limits = src.slice(src.indexOf("export function renderLimits"), src.indexOf("export function renderErrors"));
    const typed = [...limits.matchAll(/\|\s*(\d+)\s+per/g)].map((m) => m[1]);
    assert.deepEqual(typed, [], `a literal budget was typed into the table: ${typed.join(", ")}`);
  });

  it("the error reference covers the WHOLE registry, not a curated subset", async () => {
    // A partial reference is worse than none: a client branches on a code it
    // cannot find documented and assumes it is undefined behaviour.
    const body = await (await doc("errors")).text();
    for (const code of Object.keys(ERROR_CODES)) {
      assert.match(body, new RegExp(`\\b${code}\\b`), `${code} is missing from the error reference`);
    }
  });

  it("no published doc leaks a secret-shaped string", async () => {
    // These are served to the anonymous internet; a pasted key in a hand-written
    // file would go with them.
    for (const slug of PUBLISHED) {
      const body = await (await doc(slug)).text();
      assert.doesNotMatch(
        body,
        /sk_live_|sk_test_[A-Za-z0-9]{10}|postgres:\/\/[^\s`"]*:[^\s`"]*@/,
        `${slug} contains a secret-shaped string`,
      );
    }
  });
});

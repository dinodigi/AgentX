/**
 * REPRO ATTEMPT — Stallion field report 2026-07-20: "workflow actions don't
 * fire right after a redefine."
 *
 * The sprint plan lists three candidate causes and forbids a fix until one is
 * DEMONSTRATED (reproduce-before-fixing). This script drives the exact reported
 * shape against a live dev server and reports what actually happens:
 *
 *   1. baseline           — transition fires its action (proves the wiring)
 *   2. redefine, then transition immediately (t≈0s)
 *   3. redefine, then transition after the collection-cache TTL (t≈20s)
 *   4. redefine, then transition well past it (t≈65s — the reported window)
 *
 * A miss in 2 but not 3/4 implicates config-cache lag. A miss in all of them
 * implicates the deferred fire-and-forget path (lib/entries.ts:262). No miss at
 * all means the report's cause is elsewhere and the plan's three candidates are
 * all wrong — which is itself the finding.
 *
 * Run (dev server must be up):
 *   SMOKE_BASE=http://localhost:3100 node --env-file=.env scripts/repro-workflow-after-redefine.mjs
 */
import { ensureServer, createEphemeralProject, mcp, startWebhookReceiver, waitFor } from "./smoke/helpers.mjs";

const FIRE_WAIT_MS = 12_000;

await ensureServer();
const p = await createEphemeralProject("repro-wf-redefine");
const receiver = await startWebhookReceiver();

const workflow = {
  field: "status",
  initial: "draft",
  transitions: [
    { from: "draft", to: "submitted", actors: ["delivery", "mcp", "admin"] },
    { from: "submitted", to: "approved", actions: [{ type: "webhook", url: receiver.url }] },
  ],
};

const define = () =>
  mcp(p.mcpToken, "define_collection", {
    name: "requests",
    fields: [
      { name: "title", label: "T", type: "text", required: true },
      { name: "status", label: "S", type: "enum", options: ["draft", "submitted", "approved"] },
    ],
    workflow,
  });

/** Drive one entry draft → submitted → approved; return whether the action fired. */
async function driveTransition(label) {
  const before = receiver.received.length;
  const created = await mcp(p.mcpToken, "create_entry", {
    collection: "requests",
    data: { title: label, status: "draft" },
  });
  if (!created.ok) return { label, fired: false, note: `create failed: ${created.errorText}` };
  const id = created.value.id;

  const toSubmitted = await mcp(p.mcpToken, "update_entry", {
    collection: "requests",
    id,
    data: { status: "submitted" },
  });
  if (!toSubmitted.ok) return { label, fired: false, note: `→submitted failed: ${toSubmitted.errorText}` };

  const toApproved = await mcp(p.mcpToken, "update_entry", {
    collection: "requests",
    id,
    data: { status: "approved" },
  });
  if (!toApproved.ok) return { label, fired: false, note: `→approved failed: ${toApproved.errorText}` };

  try {
    await waitFor(() => receiver.received.length > before, { timeoutMs: FIRE_WAIT_MS, stepMs: 300 });
    return { label, fired: true, note: "" };
  } catch {
    return { label, fired: false, note: `no webhook within ${FIRE_WAIT_MS / 1000}s` };
  }
}

const results = [];
let fatal = null;
try {
  const first = await define();
  if (!first.ok) throw new Error(`initial define failed: ${first.errorText}`);
  results.push(await driveTransition("baseline (no redefine)"));

  for (const waitSec of [0, 20, 65]) {
    const re = await define();
    if (!re.ok) throw new Error(`redefine failed: ${re.errorText}`);
    if (waitSec > 0) await new Promise((r) => setTimeout(r, waitSec * 1000));
    results.push(await driveTransition(`redefine, then transition at t+${waitSec}s`));
  }
} catch (e) {
  // NEVER let a setup failure masquerade as "not reproduced" — an empty result
  // set is a broken harness, not a passing platform.
  fatal = e instanceof Error ? e.message : String(e);
} finally {
  console.log("\n=== repro results ===");
  for (const r of results) {
    console.log(`  ${r.fired ? "FIRED  " : "MISSED "} ${r.label}${r.note ? `  (${r.note})` : ""}`);
  }
  const missed = results.filter((r) => !r.fired);
  if (fatal) {
    console.log(`\nHARNESS ERROR — inconclusive, not a result: ${fatal}`);
  } else if (results.length === 0) {
    console.log("\nHARNESS ERROR — no transitions ran at all. Inconclusive.");
  } else if (missed.length === 0) {
    console.log(
      "\nNOT REPRODUCED — the action fired every time, including immediately after a redefine.\n" +
        "The plan's three candidates are unsupported by this shape; the cause is elsewhere.",
    );
  } else {
    console.log(`\nREPRODUCED — ${missed.length}/${results.length} transitions did not fire.`);
  }
  await receiver.close();
  await p.destroy();
  process.exit(fatal || results.length === 0 || missed.length > 0 ? 1 : 0);
}

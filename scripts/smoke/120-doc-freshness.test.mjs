import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";

// Doc hygiene, mechanically.
//
// docs/README.md states a convention: every top-level doc opens with a class
// line — `Living — last synced <date>`, `Durable`, or `Contract`. Nothing
// enforced it, and by 2026-08-21 two things had drifted:
//
//   · BACKLOG.md said "last synced 2026-07-29" while its content had changed
//     that morning — 23 days adrift. The ship ritual updates the content and
//     forgets the stamp, every time, because nothing notices.
//   · DESIGN-BRIEF.md had no class line at all, which its own convention forbids.
//
// A stale STAMP is mechanically detectable and is what these tests catch. A doc
// that is genuinely old but honestly stamped is NOT a test failure — only a
// human can know whether the world moved. OPS.md was that case: its dateline
// matched its last commit exactly while describing health-check behaviour the
// platform had deliberately reversed after an outage.

const DOCS_DIR = "docs";
const CLASS_RE = /^>\s*\*\*(Living — last synced (\d{4}-\d{2}-\d{2})|Durable|Contract)/m;

/** Generated artifacts carry no class line by design — they are rewritten wholesale. */
const GENERATED = new Set(["ai-contract.md"]);

const topLevelDocs = readdirSync(DOCS_DIR)
  .filter((f) => f.endsWith(".md"))
  .filter((f) => !GENERATED.has(f));

/** Last commit date that touched a file, as YYYY-MM-DD. */
function lastCommit(path) {
  const out = execFileSync("git", ["log", "-1", "--format=%ad", "--date=short", "--", path], {
    encoding: "utf8",
  }).trim();
  return out || null;
}

const days = (a, b) => Math.round((Date.parse(a) - Date.parse(b)) / 86_400_000);

describe("docs: every top-level document declares its class", () => {
  it("…and none is missing one", () => {
    const missing = topLevelDocs.filter((f) => !CLASS_RE.test(readFileSync(`${DOCS_DIR}/${f}`, "utf8")));
    assert.deepEqual(
      missing,
      [],
      `these have no "Living — last synced <date>" / "Durable" / "Contract" line, which docs/README.md requires:\n  ` +
        missing.join("\n  "),
    );
  });

  it("a Living dateline parses as a real date", () => {
    for (const f of topLevelDocs) {
      const m = CLASS_RE.exec(readFileSync(`${DOCS_DIR}/${f}`, "utf8"));
      if (!m?.[2]) continue;
      assert.ok(!Number.isNaN(Date.parse(m[2])), `${f}: "${m[2]}" is not a date`);
    }
  });
});

describe("docs: a Living dateline must not lie about its own content", () => {
  // The ONE thing a machine can check: the stamp says the doc was synced on a
  // date, and git says the content changed later. That is a stamp that is wrong,
  // not a doc that is merely old.
  const TOLERANCE_DAYS = 3;

  it("no Living doc claims to be newer-synced than its last content change is old", () => {
    const stale = [];
    for (const f of topLevelDocs) {
      const path = `${DOCS_DIR}/${f}`;
      const m = CLASS_RE.exec(readFileSync(path, "utf8"));
      if (!m?.[2]) continue; // Durable / Contract carry no date to check
      const committed = lastCommit(path);
      if (!committed) continue; // never committed — nothing to compare against
      const drift = days(committed, m[2]);
      if (drift > TOLERANCE_DAYS) {
        stale.push(`${f}: stamped ${m[2]} but content changed ${committed} (${drift} days adrift)`);
      }
    }
    assert.deepEqual(
      stale,
      [],
      "a Living dateline is older than the content it stamps — bump it in the same commit:\n  " + stale.join("\n  "),
    );
  });

  it("the tolerance is small enough to catch the real case", () => {
    // BACKLOG.md drifted 23 days before anyone noticed. A tolerance that would
    // have let that pass is not a guard, so pin the constant itself.
    assert.ok(TOLERANCE_DAYS <= 7, `tolerance of ${TOLERANCE_DAYS} days is too loose to catch a real drift`);
  });
});

describe("docs: the plan index is complete", () => {
  it("every file in plans/ is linked from README", () => {
    // Nine were missing. An index that omits half a folder is worse than no
    // index, because it reads as complete.
    const readme = readFileSync(`${DOCS_DIR}/README.md`, "utf8");
    const unlisted = readdirSync(`${DOCS_DIR}/plans`)
      .filter((f) => f.endsWith(".md"))
      .filter((f) => !readme.includes(f));
    assert.deepEqual(unlisted, [], "plans not linked from docs/README.md:\n  " + unlisted.join("\n  "));
  });
});

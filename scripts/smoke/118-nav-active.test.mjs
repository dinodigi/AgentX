import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { activeHref } from "../../lib/nav-active.ts";

// Operator report: "the overview is always highlighted no matter where I click on
// any other tab" — and two items lit at once.
//
// Cause: the rail decided active with `pathname === href || pathname.startsWith(
// href + "/")`, which makes an INDEX route match every one of its children. On
// /admin/<id>/connectors the Overview item (href /admin/<id>) tested true, so it
// stayed lit forever. The same bug hit the platform group, where
// /admin/console/feedback highlighted Console as well as Feedback.
//
// Longest-prefix wins fixes the class, not the two index routes we happen to have.
describe("nav: exactly one item is active, and it is the most specific", () => {
  const P = "/admin/abc123";
  const PROJECT = [P, `${P}/schema`, `${P}/assets`, `${P}/trash`, `${P}/plugins`, `${P}/appearance`, `${P}/connectors`, `${P}/api`, `${P}/settings`];
  const EXACT = [P];
  const WORKSPACE = ["/admin", "/admin/workspace", "/admin/new", "/admin/console", "/admin/console/feedback", "/admin/console/plugins"];

  it("THE BUG: a project sub-route selects itself, not Overview", () => {
    for (const seg of ["schema", "assets", "trash", "plugins", "appearance", "connectors", "api", "settings"]) {
      assert.equal(
        activeHref(`${P}/${seg}`, PROJECT, EXACT),
        `${P}/${seg}`,
        `${seg} must be the active item — Overview must not win by being a prefix`,
      );
    }
  });

  it("the project index still selects Overview", () => {
    assert.equal(activeHref(P, PROJECT, EXACT), P);
  });

  it("a nested route below a sub-route keeps the sub-route active", () => {
    // /admin/<id>/settings/tokens should light Settings, not Overview.
    assert.equal(activeHref(`${P}/settings/tokens`, PROJECT, EXACT), `${P}/settings`);
  });

  it("a collection route (not in the rail) selects NOTHING in the project group", () => {
    // Content lives in the other sidebar. Overview used to light up here too.
    assert.equal(activeHref(`${P}/some_collection`, PROJECT, EXACT), null);
  });

  it("the platform group does not light two items at once", () => {
    assert.equal(activeHref("/admin/console/feedback", WORKSPACE), "/admin/console/feedback");
    assert.equal(activeHref("/admin/console/plugins", WORKSPACE), "/admin/console/plugins");
    assert.equal(activeHref("/admin/console", WORKSPACE), "/admin/console");
    assert.equal(activeHref("/admin", WORKSPACE), "/admin");
  });

  it("a prefix that is not a whole segment does not match", () => {
    // /admin/new must not be considered the parent of /admin/newsletter.
    assert.equal(activeHref("/admin/newsletter", ["/admin", "/admin/new"]), "/admin");
  });

  it("only ever returns one answer", () => {
    // The property the report was really about: never two highlights.
    for (const path of [...PROJECT, `${P}/settings/tokens`, "/admin/console/feedback"]) {
      const hrefs = path.startsWith(`${P}`) ? PROJECT : WORKSPACE;
      const winner = activeHref(path, hrefs, hrefs === PROJECT ? EXACT : []);
      const matches = hrefs.filter((h) => h === winner);
      assert.equal(matches.length <= 1, true, `${path} produced more than one active href`);
    }
  });
});

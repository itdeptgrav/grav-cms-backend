// services/ensureAccessDepartments.test.js
//
// THE DEPARTMENT REGISTRY, AS A CONTRACT.
//
// `DEPARTMENTS` is the list a restart seeds and the list Access Control reads
// to decide which applications can be granted at all. An app missing from it is
// not "not yet wired up" — it is correct, deployed and unreachable by everybody
// except a platform administrator, which is exactly the state Marketing was in.
//
// So the facts a screen and a route both depend on are pinned here: the slug
// (which is the route identity and what every guard checks), the dashboard path
// (where the switcher sends somebody), and the user type. Renaming any of the
// three silently moves an app somewhere nobody can follow.
//
// Pure: the module is required for its exported array only. Nothing here opens
// a connection, and `ensureAccessDepartments` itself is not called.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { DEPARTMENTS } = require("./ensureAccessDepartments");

const bySlug = (slug) => DEPARTMENTS.find((d) => d.slug === slug) || null;

test("PPC is a grantable application with a real landing page", () => {
  const ppc = bySlug("ppc");
  assert.ok(ppc);
  assert.equal(ppc.dashboardPath, "/ppc");
  assert.equal(ppc.legacyModel, null);
  assert.equal(ppc.legacyUserType, "ppc");
  assert.notEqual(ppc.dashboardPath, bySlug("ie")?.dashboardPath);
});

test.describe("the registry is internally consistent", () => {
  test("every entry carries the four fields an app is reached by", () => {
    for (const dept of DEPARTMENTS) {
      assert.ok(dept.key, `missing key: ${JSON.stringify(dept)}`);
      assert.ok(dept.slug, `${dept.key} has no slug`);
      assert.ok(dept.name, `${dept.key} has no name`);
      assert.ok(
        typeof dept.dashboardPath === "string" && dept.dashboardPath.startsWith("/"),
        `${dept.key} has no absolute dashboard path`,
      );
    }
  });

  test("keys and slugs are unique", () => {
    const keys = DEPARTMENTS.map((d) => d.key);
    const slugs = DEPARTMENTS.map((d) => d.slug);
    assert.equal(new Set(keys).size, keys.length, "duplicate department key");
    assert.equal(new Set(slugs).size, slugs.length, "duplicate department slug");
  });
});

test.describe("Marketing is registered as its own application", () => {
  test("the slug, name, dashboard path and user type are the agreed ones", () => {
    const marketing = bySlug("marketing");
    assert.ok(marketing, "Marketing is not in the department registry");
    assert.equal(marketing.key, "marketing");
    assert.equal(marketing.name, "Marketing");
    /* The address the frontend shell, middleware and DepartmentGuard all use.
       A path that disagrees with the route sends the app switcher to a 404. */
    assert.equal(marketing.dashboardPath, "/marketing");
    assert.equal(marketing.legacyUserType, "marketing");
  });

  test("it is grantable — shown on onboarding, active, and system-owned", () => {
    const marketing = bySlug("marketing");
    /* These are the `$setOnInsert` defaults every entry receives, asserted
       through the shape rather than the write: a department with no legacy
       model registers the row and nothing else, which is the whole change. */
    assert.equal(marketing.legacyModel, null);
    assert.ok(marketing.description, "an ungranted app with no description is a blank tile");
  });

  test("it does not borrow Sales' slug, name or dashboard", () => {
    const marketing = bySlug("marketing");
    const sales = bySlug("sales");
    assert.ok(sales, "Sales disappeared from the registry");
    /* Marketing and Sales are separate applications. Sharing any of these
       three would be the first step to sharing the customer master. */
    assert.notEqual(marketing.slug, sales.slug);
    assert.notEqual(marketing.dashboardPath, sales.dashboardPath);
    assert.notEqual(marketing.legacyUserType, sales.legacyUserType);
  });

  test("registering it did not disturb any other department", () => {
    /* The change is one array entry. If a merge ever turns it into an edit of
       a neighbour, this is what says so. */
    for (const [slug, path] of [
      ["sales", "/sales/dashboard"],
      ["merchandiser", "/merchandiser/dashboard"],
      ["accountant", "/accountant/"],
      ["hr", "/hr/dashboard"],
    ]) {
      assert.equal(bySlug(slug)?.dashboardPath, path, `${slug} moved`);
    }
  });
});

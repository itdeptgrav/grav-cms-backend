// test/access/department-role-cache.test.js
//
// A ROLE THAT SAVED MUST NOT BE REPORTED AS A FAILURE.
//
// ── THE REGRESSION ──────────────────────────────────────────────────────────
// `setRole` writes the DepartmentRole row and then calls `dropRoleCaches` to
// clear QC's per-viewer cache. The helper went missing while its two call sites
// stayed, so every non-accounting grant and revoke did this:
//
//     await DepartmentRole.findOneAndUpdate(...)   ← the row is written
//     dropRoleCaches(slug, mail)                   ← ReferenceError
//
// The database was correct and the request threw. Access Control showed an
// error, the admin retried, and the retry "failed" too — because it also
// succeeded and also threw. The only way to find out the grant had worked was
// to reload the page.
//
// That shape of bug — the write lands, the response says otherwise — is worth
// pinning at both levels: the service (where it threw) and the route (where a
// person saw it). Both are below.
//
// ── WHY QC IS THE ONLY DEPARTMENT THAT NEEDS THIS ───────────────────────────
// services/qcViewer.js caches "which role does this email hold" for a minute so
// its dashboard does not do nine identical lookups per page load. Nothing else
// caches roles, so nothing else needs clearing. The helper is deliberately
// narrow, and these tests pin that narrowness: a broader invalidation would be
// wasted work everywhere else, and pretending every department has a cache
// would invite one to be added without the matching call.
"use strict";

/* Employee's pre-save hook encrypts salary fields and refuses without a key. */
process.env.SALARY_ENCRYPTION_KEY =
  process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const express = require("express");
const mongoose = require("mongoose");

const DepartmentRole = require("../../models/Access/DepartmentRole");
const deptRoles = require("../../services/departmentRoles");
const qcViewer = require("../../services/qcViewer");

let server, base;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  /* The admin router sits behind requirePlatformAdmin in server.js. The guard
     is not what is under test — the response to a successful write is — so it
     is replaced with a fixed admin rather than reimplemented. */
  app.use(
    "/api/admin",
    (req, _res, next) => {
      req.admin = { _id: new mongoose.Types.ObjectId(), email: "admin@test.example" };
      next();
    },
    require("../../routes/Admin/accessAdmin"),
  );
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });
afterEach(() => { jest.restoreAllMocks(); });

const putRole = (slug, body) =>
  fetch(`${base}/api/admin/department-roles/${slug}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

/* ══ 1 · A NON-QC ROLE: THE PATH THAT THREW ════════════════════════════════ */

test("assigning a non-QC role returns success after persisting it", async () => {
  const result = await deptRoles.setRole({
    departmentSlug: "store",
    email: "Grant.Me@Test.Example",
    name: "Grant Me",
    role: "editor",
  });

  expect(result.role).toBe("editor");
  expect(result.created).toBe(true);

  const row = await DepartmentRole.findOne({
    departmentSlug: "store", email: "grant.me@test.example",
  }).lean();
  expect(row).toBeTruthy();
  expect(row.role).toBe("editor");
  expect(row.isActive).toBe(true);
});

test("revoking a non-QC role returns success after persisting it", async () => {
  await deptRoles.setRole({
    departmentSlug: "store", email: "revoke.me@test.example", role: "editor",
  });

  const result = await deptRoles.setRole({
    departmentSlug: "store", email: "revoke.me@test.example", role: null,
  });

  expect(result.role).toBeNull();
  expect(result.revoked).toBe(true);

  const row = await DepartmentRole.findOne({
    departmentSlug: "store", email: "revoke.me@test.example",
  }).lean();
  expect(row.isActive).toBe(false);
});

test("an owner promotion still demotes the incumbent and returns cleanly", async () => {
  /* The department-wide `dropRoleCaches(slug, null)` sits directly after this
     demotion, so it is the call site most likely to be reached in real use. */
  await deptRoles.setRole({
    departmentSlug: "store", email: "old.owner@test.example", role: "owner",
  });
  const result = await deptRoles.setRole({
    departmentSlug: "store", email: "new.owner@test.example", role: "owner",
  });

  expect(result.role).toBe("owner");
  const demoted = await DepartmentRole.findOne({
    departmentSlug: "store", email: "old.owner@test.example",
  }).lean();
  expect(demoted.role).toBe("approver");
});

/* ══ 2 · QC: THE ONE DEPARTMENT WITH A CACHE ═══════════════════════════════ */

test("assigning a QC role invalidates the QC viewer cache", async () => {
  const spy = jest.spyOn(qcViewer, "invalidateViewer");

  await deptRoles.setRole({
    departmentSlug: "qc", email: "qc.person@test.example", role: "editor",
  });

  /* Whole-department, not just this email: an owner promotion demotes the
     incumbent, so somebody else's cached role is stale too. */
  expect(spy).toHaveBeenCalledWith(null);
});

test("revoking a QC role invalidates that viewer's cached role", async () => {
  await deptRoles.setRole({
    departmentSlug: "qc", email: "qc.leaver@test.example", role: "editor",
  });

  const spy = jest.spyOn(qcViewer, "invalidateViewer");
  await deptRoles.setRole({
    departmentSlug: "qc", email: "qc.leaver@test.example", role: null,
  });

  /* A revoke touches one person, so it clears one entry rather than the lot. */
  expect(spy).toHaveBeenCalledWith("qc.leaver@test.example");
});

test("no other department pays for QC's cache", async () => {
  const spy = jest.spyOn(qcViewer, "invalidateViewer");

  for (const slug of ["store", "budget", "hr", "production"]) {
    await deptRoles.setRole({
      departmentSlug: slug, email: `p.${slug}@test.example`, role: "viewer",
    });
  }

  expect(spy).not.toHaveBeenCalled();
});

test("a broken QC cache cannot fail a grant that already saved", async () => {
  /* The whole point of the try/catch: the row is written before the cache is
     touched, so a cache problem must not turn a completed grant into an error.
     A stale QC dashboard for sixty seconds is a far smaller problem than an
     admin being told the grant failed when it did not. */
  const spy = jest.spyOn(qcViewer, "invalidateViewer").mockImplementation(() => {
    throw new Error("cache backend unavailable");
  });
  const warn = jest.spyOn(console, "warn").mockImplementation(() => {});

  const result = await deptRoles.setRole({
    departmentSlug: "qc", email: "qc.resilient@test.example", role: "approver",
  });

  expect(result.role).toBe("approver");
  const row = await DepartmentRole.findOne({
    departmentSlug: "qc", email: "qc.resilient@test.example",
  }).lean();
  expect(row.role).toBe("approver");
  expect(spy).toHaveBeenCalled();
  expect(warn).toHaveBeenCalled();          // skipped out loud, not silently
});

/* ══ 3 · WHAT THE ADMIN ACTUALLY SAW ═══════════════════════════════════════ */

describe("a successful write is not presented as a failure", () => {
  test("granting a role answers 200, not 500, with the row written", async () => {
    const res = await putRole("store", {
      email: "ui.grant@test.example", name: "UI Grant", role: "editor",
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.role).toBe("editor");
    /* The exact symptom: the row exists AND the response says so. Before the
       fix the first was true and the second was a 500. */
    const row = await DepartmentRole.findOne({
      departmentSlug: "store", email: "ui.grant@test.example",
    }).lean();
    expect(row.role).toBe("editor");
  });

  test("revoking a role answers 200, not 500, with the row deactivated", async () => {
    await putRole("store", { email: "ui.revoke@test.example", role: "editor" });

    const res = await putRole("store", { email: "ui.revoke@test.example", role: null });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.role).toBeNull();
    const row = await DepartmentRole.findOne({
      departmentSlug: "store", email: "ui.revoke@test.example",
    }).lean();
    expect(row.isActive).toBe(false);
  });

  test("a QC grant answers 200 too", async () => {
    const res = await putRole("qc", { email: "ui.qc@test.example", role: "approver" });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.role).toBe("approver");
  });

  test("retrying a grant does not produce a second, contradictory answer", async () => {
    /* What the admin did when the screen said it had failed. Both attempts
       succeed, and the second reports `created: false` rather than erroring —
       so the repeated click that used to look like two failures now looks like
       what it is. */
    const first = await putRole("store", { email: "ui.retry@test.example", role: "editor" });
    const second = await putRole("store", { email: "ui.retry@test.example", role: "editor" });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.role).toBe("editor");
    expect(await DepartmentRole.countDocuments({
      departmentSlug: "store", email: "ui.retry@test.example",
    })).toBe(1);
  });
});

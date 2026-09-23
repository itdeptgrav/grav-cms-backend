// ACCESS CONTROL'S OWN SAFEGUARDS, AND THE CONTRACT ITS SCREEN RELIES ON.
//
// Three things are pinned here:
//
//   1. The last active administrator cannot be DEACTIVATED. Revoking the flag
//      and removing the login were both guarded; deactivation was not, and
//      `requirePlatformAdmin` admits only an active administrator — so it
//      locked everybody out of the screen that grants administrators. You also
//      cannot deactivate the account you are signed in with (DELETE already
//      refused removing it).
//
//   2. GET /department-logins lists accounts that exist ONLY in `dept_users`.
//      Sign-in tries that table first, so those accounts sign in; the list
//      read only the legacy collections, so an account created on the tab
//      itself — or a bootstrapped administrator — was invisible there.
//
//   3. PATCH /employees/:id takes the primary and the extras together. The
//      screen now changes a primary in one request instead of two, and relies
//      on the route filtering the extras against the NEW primary.
//
//   4. …and that one request is all-or-nothing. The route used to write the
//      extras (and record them) before validating the primary; it now
//      validates the whole requested state, then writes both fields in ONE
//      updateOne, then records. A refused primary or a failed write leaves
//      both fields unchanged and records nothing.
//
//   5. No change may leave no administrator able to sign in. An administrator
//      is usable only when isAdmin, isActive AND in an active department
//      (sign-in refuses a department account whose department is inactive).
//      Deactivating or deleting the department that holds the last usable
//      administrator is refused — built-in departments included — as are
//      revoking, deactivating, moving or removing that administrator.
//
// Mounted WITHOUT requirePlatformAdmin, as the other Access Control route
// suites are — that guard is server.js's. `req.admin` is what the routes read
// for self-checks and the audit trail.
"use strict";
process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const express = require("express");
const mongoose = require("mongoose");
const AccessDepartment = require("../../models/Access/AccessDepartment");
const DeptUser = require("../../models/Access/DeptUser");
const Employee = require("../../models/Employee");

let server, base;
const SIGNED_IN = new mongoose.Types.ObjectId();

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.admin = { _id: SIGNED_IN, email: "admin@grav.in" };
    next();
  });
  app.use("/api/admin", require("../../routes/Admin/accessAdmin"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/admin`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

const call = (method, path, body) =>
  fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

let seq = 0;
const dept = (slug, extra = {}) =>
  AccessDepartment.create({
    key: slug.replace(/-/g, "_"), slug, name: slug.toUpperCase(), dashboardPath: `/d/${slug}`,
    legacyModel: "GenericDepartmentUser", legacyRole: slug, legacyUserType: slug, isActive: true, ...extra,
  });
const account = (departmentId, fields = {}) =>
  DeptUser.create({
    email: `user${++seq}@grav.in`, name: `User ${seq}`, passwordHash: "x", departmentId,
    isActive: true, isAdmin: false, ...fields,
  });

/* ═══ 1. THE LAST ADMINISTRATOR ════════════════════════════════════════════ */

test("the only active administrator cannot be deactivated", async () => {
  const d = await dept("ceo");
  const only = await account(d._id, { isAdmin: true });

  const res = await call("PATCH", `/users/${only._id}`, { isActive: false });

  expect(res.status).toBe(400);
  expect(res.body.message).toMatch(/only active administrator/);
  const after = await DeptUser.findById(only._id).lean();
  expect(after.isActive).toBe(true);
  expect(after.tokenVersion || 0).toBe(0); // not signed out either
});

test("an inactive second administrator does not count as a way back in", async () => {
  const d = await dept("ceo");
  const only = await account(d._id, { isAdmin: true });
  await account(d._id, { isAdmin: true, isActive: false });

  const res = await call("PATCH", `/users/${only._id}`, { isActive: false });
  expect(res.status).toBe(400);
});

test("an administrator can be deactivated while another active one remains", async () => {
  const d = await dept("ceo");
  const target = await account(d._id, { isAdmin: true });
  await account(d._id, { isAdmin: true });

  const res = await call("PATCH", `/users/${target._id}`, { isActive: false });

  expect(res.status).toBe(200);
  const after = await DeptUser.findById(target._id).lean();
  expect(after.isActive).toBe(false);
  expect(after.tokenVersion).toBe(1); // signed out immediately, as before
});

test("you cannot deactivate the account you are signed in with", async () => {
  const d = await dept("ceo");
  const me = await DeptUser.create({
    _id: SIGNED_IN, email: "admin@grav.in", name: "Me", passwordHash: "x", departmentId: d._id,
    isActive: true, isAdmin: true,
  });
  await account(d._id, { isAdmin: true }); // not the last admin — the self rule applies anyway

  const res = await call("PATCH", `/users/${me._id}`, { isActive: false });

  expect(res.status).toBe(400);
  expect(res.body.message).toMatch(/signed in with/);
});

test("revoking the flag from the only administrator is still refused (unchanged)", async () => {
  const d = await dept("ceo");
  const only = await account(d._id, { isAdmin: true });
  const res = await call("PATCH", `/users/${only._id}`, { isAdmin: false });
  expect(res.status).toBe(400);
  expect((await DeptUser.findById(only._id).lean()).isAdmin).toBe(true);
});

test("deactivating an ordinary account is unaffected", async () => {
  const d = await dept("sales");
  await account(d._id, { isAdmin: true });
  const plain = await account(d._id);
  const res = await call("PATCH", `/users/${plain._id}`, { isActive: false });
  expect(res.status).toBe(200);
  expect((await DeptUser.findById(plain._id).lean()).isActive).toBe(false);
});

/* ═══ 2. EVERY ACCOUNT THAT CAN SIGN IN IS LISTED ══════════════════════════ */

test("an account that exists only in dept_users is listed, with its admin flag", async () => {
  const d = await dept("ceo");
  const created = await account(d._id, { isAdmin: true, name: "Bootstrap Admin" });

  const res = await call("GET", "/department-logins");

  expect(res.status).toBe(200);
  const row = res.body.logins.find((l) => l._id === String(created._id));
  expect(row).toBeDefined();
  expect(row.collection).toBeNull();
  expect(row.source).toBe("access-table");
  expect(row.mirrored).toBe(true);
  expect(row.isAdmin).toBe(true);
  expect(row.departmentName).toBe("CEO");
  expect(row.name).toBe("Bootstrap Admin");
});

test("a legacy credential with a mirror is listed once, not twice", async () => {
  const d = await dept("hr");
  const id = new mongoose.Types.ObjectId();
  await mongoose.connection.collection("hrdepartments").insertOne({
    _id: id, name: "HR Shared", email: "hr@grav.in", password: "hash", isActive: true,
  });
  await DeptUser.create({ _id: id, email: "hr@grav.in", name: "HR Shared", passwordHash: "x", departmentId: d._id, isActive: true });

  const res = await call("GET", "/department-logins");
  const rows = res.body.logins.filter((l) => l._id === String(id));
  expect(rows).toHaveLength(1);
  expect(rows[0].collection).toBe("hrdepartments");
  expect(rows[0].mirrored).toBe(true);
});

test("inactive access-table accounts appear only when asked for", async () => {
  const d = await dept("sales");
  const off = await account(d._id, { isActive: false });

  const hidden = await call("GET", "/department-logins");
  expect(hidden.body.logins.some((l) => l._id === String(off._id))).toBe(false);

  const shown = await call("GET", "/department-logins?includeInactive=true");
  const row = shown.body.logins.find((l) => l._id === String(off._id));
  expect(row).toBeDefined();
  expect(row.isActive).toBe(false);
});

/* ═══ 3. ONE REQUEST CHANGES A PRIMARY ═════════════════════════════════════ */

const employeeWith = (primary, extras) =>
  Employee.create({
    firstName: "Priya", lastName: "Sharma", email: `priya${++seq}@grav.in`, isActive: true, gender: "Other",
    accessDepartmentId: primary, additionalDepartmentIds: extras,
  });

test("revoking the primary and promoting the next grant is one request", async () => {
  const [hr, store, qc] = await Promise.all([dept("hr"), dept("store"), dept("qc")]);
  const e = await employeeWith(hr._id, [store._id, qc._id]);

  const res = await call("PATCH", `/employees/${e._id}`, {
    accessDepartmentId: String(store._id),
    additionalDepartmentIds: [String(qc._id)],
  });

  expect(res.status).toBe(200);
  const after = await Employee.findById(e._id).lean();
  expect(String(after.accessDepartmentId)).toBe(String(store._id));
  expect(after.additionalDepartmentIds.map(String)).toEqual([String(qc._id)]);
});

test("making an extra primary never leaves it listed as an extra too", async () => {
  const [hr, store] = await Promise.all([dept("hr"), dept("store")]);
  const e = await employeeWith(hr._id, [store._id]);

  // The screen sends the old primary among the extras and the new one as primary.
  const res = await call("PATCH", `/employees/${e._id}`, {
    accessDepartmentId: String(store._id),
    additionalDepartmentIds: [String(hr._id), String(store._id)],
  });

  expect(res.status).toBe(200);
  const after = await Employee.findById(e._id).lean();
  expect(String(after.accessDepartmentId)).toBe(String(store._id));
  expect(after.additionalDepartmentIds.map(String)).toEqual([String(hr._id)]);
});

test("removing the only department in one request leaves no access at all", async () => {
  const hr = await dept("hr");
  const e = await employeeWith(hr._id, []);

  const res = await call("PATCH", `/employees/${e._id}`, { accessDepartmentId: null, additionalDepartmentIds: [] });

  expect(res.status).toBe(200);
  expect(res.body.message).toMatch(/can no longer sign in/);
  const after = await Employee.findById(e._id).lean();
  expect(after.accessDepartmentId).toBeNull();
  expect(after.additionalDepartmentIds).toEqual([]);
});

/* ═══ 4. A GRANT CHANGE IS VALIDATED WHOLE AND WRITTEN ONCE ═════════════════
   The route used to write the extras, record that it had, and only then look
   up the primary — so a refused primary left the extras changed. These pin
   the fix: validate everything, then one updateOne, then record. */

const ChangeLog = require("../../models/Access/ChangeLog");
const grantsOf = async (id) => {
  const e = await Employee.findById(id).lean();
  return { primary: e.accessDepartmentId ? String(e.accessDepartmentId) : null, extras: (e.additionalDepartmentIds || []).map(String) };
};

test("a successful combined change is one database write carrying both fields", async () => {
  const [hr, store, qc] = await Promise.all([dept("hr"), dept("store"), dept("qc")]);
  const e = await employeeWith(hr._id, [store._id, qc._id]);
  const spy = jest.spyOn(Employee, "updateOne");

  const res = await call("PATCH", `/employees/${e._id}`, {
    accessDepartmentId: String(store._id),
    additionalDepartmentIds: [String(qc._id)],
  });

  expect(res.status).toBe(200);
  expect(res.body.message).toMatch(/can now sign in to STORE/);
  expect(spy).toHaveBeenCalledTimes(1);
  const [, update] = spy.mock.calls[0];
  expect(Object.keys(update.$set).sort()).toEqual(["accessDepartmentId", "additionalDepartmentIds"]);
  spy.mockRestore();
  expect(await grantsOf(e._id)).toEqual({ primary: String(store._id), extras: [String(qc._id)] });
  // Both halves are in the history, as before.
  const entities = (await ChangeLog.find({ entityId: e.email }).lean()).map((c) => c.entity).sort();
  expect(entities).toEqual(["employee-department", "employee-department-extra"]);
});

test("an inactive primary is refused and leaves BOTH fields unchanged", async () => {
  const [hr, store, off] = await Promise.all([dept("hr"), dept("store"), dept("closed", { isActive: false })]);
  const e = await employeeWith(hr._id, [store._id]);
  const before = await grantsOf(e._id);

  const res = await call("PATCH", `/employees/${e._id}`, {
    accessDepartmentId: String(off._id),
    additionalDepartmentIds: [],               // would have cleared the extras first
  });

  expect(res.status).toBe(400);
  expect(res.body.message).toMatch(/not active/);
  expect(await grantsOf(e._id)).toEqual(before);
  expect(await ChangeLog.countDocuments({ entityId: e.email })).toBe(0);
});

test("a primary that does not exist is refused and changes nothing", async () => {
  const [hr, store, qc] = await Promise.all([dept("hr"), dept("store"), dept("qc")]);
  const e = await employeeWith(hr._id, [store._id]);
  const before = await grantsOf(e._id);

  const res = await call("PATCH", `/employees/${e._id}`, {
    accessDepartmentId: String(new mongoose.Types.ObjectId()),
    additionalDepartmentIds: [String(qc._id)],
  });

  expect(res.status).toBe(400);
  expect(await grantsOf(e._id)).toEqual(before);
  expect(await ChangeLog.countDocuments({ entityId: e.email })).toBe(0);
});

test("a malformed extra id is refused and changes nothing", async () => {
  const [hr, store] = await Promise.all([dept("hr"), dept("store")]);
  const e = await employeeWith(hr._id, [store._id]);
  const before = await grantsOf(e._id);

  const res = await call("PATCH", `/employees/${e._id}`, { additionalDepartmentIds: ["not-an-id"] });

  expect(res.status).toBe(400);
  expect(await grantsOf(e._id)).toEqual(before);
});

test("a failed write leaves both fields unchanged and records nothing", async () => {
  const [hr, store, qc] = await Promise.all([dept("hr"), dept("store"), dept("qc")]);
  const e = await employeeWith(hr._id, [store._id]);
  const before = await grantsOf(e._id);
  const spy = jest.spyOn(Employee, "updateOne").mockRejectedValueOnce(new Error("write concern timeout"));

  const res = await call("PATCH", `/employees/${e._id}`, {
    accessDepartmentId: String(qc._id),
    additionalDepartmentIds: [String(hr._id)],
  });

  spy.mockRestore();
  expect(res.status).toBe(500);
  expect(await grantsOf(e._id)).toEqual(before);
  expect(await ChangeLog.countDocuments({ entityId: e.email })).toBe(0);
});

test("an empty body changes nothing (it used to revoke the primary)", async () => {
  const hr = await dept("hr");
  const e = await employeeWith(hr._id, []);
  const res = await call("PATCH", `/employees/${e._id}`, {});
  expect(res.status).toBe(400);
  expect((await grantsOf(e._id)).primary).toBe(String(hr._id));
});

test("setting only the primary to a held extra removes it from the extras in the same write", async () => {
  const [hr, store] = await Promise.all([dept("hr"), dept("store")]);
  const e = await employeeWith(hr._id, [store._id]);
  const res = await call("PATCH", `/employees/${e._id}`, { accessDepartmentId: String(store._id) });
  expect(res.status).toBe(200);
  expect(await grantsOf(e._id)).toEqual({ primary: String(store._id), extras: [] });
});

test("extras naming a department switched off since are dropped, not refused (unchanged tolerance)", async () => {
  const [hr, store, off] = await Promise.all([dept("hr"), dept("store"), dept("closed", { isActive: false })]);
  const e = await employeeWith(hr._id, [store._id]);
  const res = await call("PATCH", `/employees/${e._id}`, { additionalDepartmentIds: [String(store._id), String(off._id)] });
  expect(res.status).toBe(200);
  expect(res.body.message).toBe("Priya can now also open STORE.");
  expect(await grantsOf(e._id)).toEqual({ primary: String(hr._id), extras: [String(store._id)] });
});

/* ═══ 5. NO CHANGE MAY LEAVE NO ADMINISTRATOR ABLE TO SIGN IN ════════════════
   Sign-in refuses a department account whose department is inactive, so an
   administrator is usable only when active AND in an active department. */

const adminIn = (d, extra = {}) => account(d._id, { isAdmin: true, ...extra });

test("deactivating the built-in department that holds the last usable admin is refused, and nothing changes", async () => {
  const ceo = await dept("ceo", { isSystem: true });
  const admin = await adminIn(ceo);

  const res = await call("PATCH", `/departments/${ceo._id}`, { isActive: false });

  expect(res.status).toBe(409);
  expect(res.body.message).toMatch(/last administrator who can sign in/);
  expect((await AccessDepartment.findById(ceo._id).lean()).isActive).toBe(true);
  const after = await DeptUser.findById(admin._id).lean();
  expect(after.isActive).toBe(true);
  expect(after.tokenVersion || 0).toBe(0); // nobody was signed out
});

test("an admin whose own department is already inactive does not count as a way back in", async () => {
  const ceo = await dept("ceo", { isSystem: true });
  const closed = await dept("closed", { isActive: false });
  await adminIn(ceo);
  await adminIn(closed); // active flag, but cannot sign in

  const res = await call("PATCH", `/departments/${ceo._id}`, { isActive: false });
  expect(res.status).toBe(409);
  expect((await AccessDepartment.findById(ceo._id).lean()).isActive).toBe(true);
});

test("a department can be deactivated while a usable administrator remains elsewhere", async () => {
  const ceo = await dept("ceo", { isSystem: true });
  const hr = await dept("hr", { isSystem: true });
  const hrAdmin = await adminIn(hr);
  await adminIn(ceo);

  const res = await call("PATCH", `/departments/${hr._id}`, { isActive: false });

  expect(res.status).toBe(200);
  expect((await AccessDepartment.findById(hr._id).lean()).isActive).toBe(false);
  expect((await DeptUser.findById(hrAdmin._id).lean()).tokenVersion).toBe(1); // signed out, as before
});

test("deleting the custom department that holds the last usable admin is refused, and nothing changes", async () => {
  const ops = await dept("ops");
  const admin = await adminIn(ops);

  const res = await call("DELETE", `/departments/${ops._id}`);

  expect(res.status).toBe(409);
  expect((await AccessDepartment.findById(ops._id).lean()).isActive).toBe(true);
  expect((await DeptUser.findById(admin._id).lean()).isActive).toBe(true);
});

test("deleting a custom department is allowed while a usable administrator remains", async () => {
  const ops = await dept("ops");
  const ceo = await dept("ceo", { isSystem: true });
  const opsAdmin = await adminIn(ops);
  await adminIn(ceo);

  const res = await call("DELETE", `/departments/${ops._id}`);
  expect(res.status).toBe(200);
  expect((await DeptUser.findById(opsAdmin._id).lean()).isActive).toBe(false);
});

test("revoking admin is refused when the only other admin sits in an inactive department", async () => {
  const ceo = await dept("ceo", { isSystem: true });
  const closed = await dept("closed", { isActive: false });
  const usable = await adminIn(ceo);
  await adminIn(closed);

  const res = await call("PATCH", `/users/${usable._id}`, { isAdmin: false });
  expect(res.status).toBe(400);
  expect((await DeptUser.findById(usable._id).lean()).isAdmin).toBe(true);
});

test("moving the last usable admin into an inactive department is refused", async () => {
  const ceo = await dept("ceo", { isSystem: true });
  const closed = await dept("closed", { isActive: false });
  const admin = await adminIn(ceo);

  const res = await call("PATCH", `/users/${admin._id}`, { departmentId: String(closed._id) });
  expect(res.status).toBe(400);
  const after = await DeptUser.findById(admin._id).lean();
  expect(String(after.departmentId)).toBe(String(ceo._id));
  expect(after.tokenVersion || 0).toBe(0);
});

test("removing the last usable admin's login is refused even with an unusable admin left", async () => {
  const hr = await dept("hr");
  const closed = await dept("closed", { isActive: false });
  const id = new mongoose.Types.ObjectId();
  await mongoose.connection.collection("hrdepartments").insertOne({ _id: id, name: "HR Admin", email: "hradmin@grav.in", isActive: true });
  await DeptUser.create({ _id: id, email: "hradmin@grav.in", name: "HR Admin", passwordHash: "x", departmentId: hr._id, isActive: true, isAdmin: true });
  await adminIn(closed);

  const res = await call("DELETE", `/department-logins/hrdepartments/${id}`);
  expect(res.status).toBe(400);
  expect(await mongoose.connection.collection("hrdepartments").countDocuments({ _id: id })).toBe(1);
  expect(await DeptUser.countDocuments({ _id: id })).toBe(1);
});

"use strict";
process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || "company-access-launcher-test";

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const Employee = require("../../models/Employee");
const DeptUser = require("../../models/Access/DeptUser");
const AccessDepartment = require("../../models/Access/AccessDepartment");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const { ensureAccessDepartments } = require("../../services/ensureAccessDepartments");
const { invalidate } = require("../../services/memo");
const { change } = require("../../services/companyContext/companyAccess.service");
const { setRole } = require("../../services/departmentRoles");

/* GAC-AR1 (25 Sep 2026): these two tests used to pin "a company PPC grant
   creates the tile / the switch". The single-organisation cutover made the
   canonical application-access resolver the only launcher input, and
   companyGrants[] is no longer one of them. They now pin the replacement: a
   company grant alone opens nothing; the PPC APPLICATION role does, and its
   revocation removes the tile and the switch on the next request. */

let server;
let base;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/auth", require("../../routes/auth/deptAuth"));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((resolve) => server.close(resolve)); });

test("a company PPC grant alone creates no tile; the PPC application role does, and revoking it removes it", async () => {
  await ensureAccessDepartments(mongoose.connection);
  invalidate("access-departments:active");
  const home = await AccessDepartment.findOne({ slug: "hr" });
  const ppc = await AccessDepartment.findOne({ slug: "ppc" });
  expect(home && ppc).toBeTruthy();
  const company = await Acc_Company.create({ companyName: "Launcher Co", booksFromDate: new Date("2026-04-01") });
  const employee = await Employee.create({
    firstName: "PPC", lastName: "Launcher", email: "launcher@grav.test",
    biometricId: "CAL1", isActive: true, gender: "Other", department: "HR",
    accessDepartmentId: home._id,
  });
  const token = jwt.sign({
    v: 2, id: String(employee._id), subject: "employee",
    email: employee.email, name: "PPC Launcher", employeeId: employee.biometricId,
    deptId: String(home._id), deptSlug: home.slug, role: home.legacyRole || home.slug,
    userType: home.legacyUserType || home.slug, isAdmin: false, tv: 0,
  }, process.env.JWT_SECRET, { expiresIn: "10m" });
  const verify = async () => {
    const response = await fetch(`${base}/api/auth/verify`, {
      method: "POST", headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
    return response.json();
  };
  const actor = { _id: new mongoose.Types.ObjectId(), name: "Admin", email: "admin@grav.test" };
  expect((await verify()).departments.map((d) => d.slug)).not.toContain("ppc");
  await change({ companyId: company._id, departmentSlug: "ppc", email: employee.email,
    role: "viewer", reason: "PPC assignment", actor });
  // The company grant writes an INACTIVE legacy row plus the scoped entry — no app role.
  expect((await verify()).departments.map((d) => d.slug)).not.toContain("ppc");
  await setRole({ departmentSlug: "ppc", email: employee.email, name: "PPC Launcher", role: "viewer" });
  expect((await verify()).departments.map((d) => d.slug)).toContain("ppc");
  await setRole({ departmentSlug: "ppc", email: employee.email, role: null });
  expect((await verify()).departments.map((d) => d.slug)).not.toContain("ppc");
});

test("a department login can switch into PPC only while its PPC application role is live", async () => {
  await ensureAccessDepartments(mongoose.connection);
  invalidate("access-departments:active");
  const home = await AccessDepartment.findOne({ slug: "sales" });
  const company = await Acc_Company.create({ companyName: "Dept Login Co", booksFromDate: new Date("2026-04-01") });
  const user = await DeptUser.create({
    name: "Sales and PPC", email: "sales-ppc@grav.test", passwordHash: "unused",
    departmentId: home._id, isActive: true, isAdmin: false,
  });
  const token = jwt.sign({
    v: 2, id: String(user._id), deptId: String(home._id), deptSlug: home.slug,
    role: home.legacyRole || home.slug, userType: home.legacyUserType || home.slug,
    email: user.email, tv: user.tokenVersion || 0,
  }, process.env.JWT_SECRET, { expiresIn: "10m" });
  const actor = { _id: new mongoose.Types.ObjectId(), name: "Admin", email: "admin@grav.test" };
  const switchToPpc = (session) => fetch(`${base}/api/auth/switch-department`, {
    method: "POST",
    headers: { Authorization: `Bearer ${session}`, "Content-Type": "application/json" },
    body: JSON.stringify({ slug: "ppc" }),
  });
  expect((await switchToPpc(token)).status).toBe(403);
  await change({ companyId: company._id, departmentSlug: "ppc", email: user.email,
    role: "viewer", reason: "PPC cover", actor });
  expect((await switchToPpc(token)).status).toBe(403); // a company grant alone opens nothing
  await setRole({ departmentSlug: "ppc", email: user.email, name: "Sales and PPC", role: "viewer" });
  const switched = await switchToPpc(token);
  expect(switched.status).toBe(200);
  const { token: ppcToken } = await switched.json();
  const verified = await fetch(`${base}/api/auth/verify`, {
    method: "POST", headers: { Authorization: `Bearer ${ppcToken}` },
  }).then((r) => r.json());
  expect(verified.user.deptSlug).toBe("ppc");
  expect(verified.user.deptRole).toBe("viewer");
  await setRole({ departmentSlug: "ppc", email: user.email, role: null });
  expect((await switchToPpc(token)).status).toBe(403);
  const after = await fetch(`${base}/api/auth/verify`, {
    method: "POST", headers: { Authorization: `Bearer ${ppcToken}` },
  }).then((r) => r.json());
  expect(after.user.deptSlug).toBe("sales");
  expect(after.departments.map((d) => d.slug)).not.toContain("ppc");
});

"use strict";
process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || "company-access-admin-route-test";

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const DeptUser = require("../../models/Access/DeptUser");
const AccessDepartment = require("../../models/Access/AccessDepartment");
const { ensureAccessDepartments } = require("../../services/ensureAccessDepartments");
const Employee = require("../../models/Employee");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const requirePlatformAdmin = require("../../Middlewear/requirePlatformAdmin");
const { roleForCompany } = require("../../services/companyContext/companyAccess.service");

let server;
let base;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/admin", requirePlatformAdmin, require("../../routes/Admin/accessAdmin"));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((resolve) => server.close(resolve)); });

test("only a live platform administrator can grant a company-specific PPC role", async () => {
  await ensureAccessDepartments(mongoose.connection);
  const dept = await AccessDepartment.findOne({ slug: "ceo" });
  const company = await Acc_Company.create({ companyName: "Route Co", booksFromDate: new Date("2026-04-01") });
  const email = "route-operator@grav.test";
  await Employee.create({
    firstName: "Route", lastName: "Operator", email, biometricId: "CAR1",
    isActive: true, gender: "Other", department: "PPC",
  });
  const admin = await DeptUser.create({
    name: "Admin", email: "access-admin@grav.test", passwordHash: "unused",
    departmentId: dept._id, isActive: true, isAdmin: true,
  });
  const nonAdmin = await DeptUser.create({
    name: "Ordinary", email: "not-admin@grav.test", passwordHash: "unused",
    departmentId: dept._id, isActive: true, isAdmin: false,
  });
  const token = (user) => jwt.sign({
    v: 2, id: String(user._id), deptId: String(dept._id), deptSlug: dept.slug,
    tv: user.tokenVersion || 0,
  }, process.env.JWT_SECRET, { expiresIn: "10m" });
  const body = JSON.stringify({
    companyId: String(company._id), departmentSlug: "ppc", email,
    role: "editor", reason: "Approved planner assignment",
  });
  const put = (bearer) => fetch(`${base}/api/admin/company-access`, {
    method: "PUT", headers: {
      "Content-Type": "application/json", ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    }, body,
  });
  expect((await put()).status).toBe(401);
  expect((await put(token(nonAdmin))).status).toBe(403);
  const legacyWrite = await fetch(`${base}/api/admin/department-roles/ppc`, {
    method: "PUT", headers: {
      "Content-Type": "application/json", Authorization: `Bearer ${token(admin)}`,
    }, body: JSON.stringify({ email, role: "owner" }),
  });
  expect(legacyWrite.status).toBe(409);
  expect((await legacyWrite.json()).code).toBe("COMPANY_SCOPED_GRANT_REQUIRED");
  expect(await roleForCompany({ companyId: company._id, email })).toBeNull();
  const result = await put(token(admin));
  expect(result.status).toBe(200);
  expect((await result.json()).grant.role).toBe("editor");
  expect(await roleForCompany({ companyId: company._id, email })).toBe("editor");
});

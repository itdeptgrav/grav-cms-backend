"use strict";
process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const mongoose = require("mongoose");
const Employee = require("../../models/Employee");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const ChangeLog = require("../../models/Access/ChangeLog");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const { change, list, roleForCompany } = require("../../services/companyContext/companyAccess.service");

let n = 0;
const company = () => Acc_Company.create({
  companyName: `Access Co ${++n}`, booksFromDate: new Date("2026-04-01"),
});
const person = async () => {
  const email = `companyaccess${++n}@grav.test`;
  const employee = await Employee.create({
    firstName: "Access", lastName: String(n), email, biometricId: `CA${n}`,
    isActive: true, gender: "Other", department: "PPC",
  });
  return { email, employee };
};
const admin = () => ({ _id: new mongoose.Types.ObjectId(), name: "Administrator", email: "admin@grav.test" });
const grant = (companyId, email, role, actor = admin()) => change({
  companyId, departmentSlug: "ppc", email, role, reason: "Approved company assignment", actor,
});

beforeAll(async () => {
  await DepartmentRole.syncIndexes();
  await SpCompanyMembership.syncIndexes();
});

test("a legacy PPC role does not multiply across two company memberships", async () => {
  const [a, b] = await Promise.all([company(), company()]);
  const { email, employee } = await person();
  await DepartmentRole.create({ departmentSlug: "ppc", email, role: "approver" });
  await SpCompanyMembership.create({ companyId: a._id, email, employeeRef: employee._id });
  expect(await roleForCompany({ companyId: a._id, email, actorId: employee._id })).toBe("approver");
  await SpCompanyMembership.create({ companyId: b._id, email, employeeRef: employee._id });
  expect(await roleForCompany({ companyId: a._id, email, actorId: employee._id })).toBeNull();
  expect(await roleForCompany({ companyId: b._id, email, actorId: employee._id })).toBeNull();
  await grant(b._id, email, "editor");
  expect(await roleForCompany({ companyId: b._id, email, actorId: employee._id })).toBe("editor");
  expect(await roleForCompany({ companyId: a._id, email, actorId: employee._id })).toBeNull();
});

test("grant retries create one membership and one audit event; revoke cannot revive a global role", async () => {
  const a = await company();
  const { email, employee } = await person();
  await DepartmentRole.create({ departmentSlug: "ppc", email, role: "owner" });
  const actor = admin();
  await grant(a._id, email, "owner", actor);
  await grant(a._id, email, "owner", actor);
  expect(await SpCompanyMembership.countDocuments({ companyId: a._id, email })).toBe(1);
  expect((await DepartmentRole.findOne({ departmentSlug: "ppc", email })).companyGrants).toHaveLength(1);
  expect(await ChangeLog.countDocuments({ entity: "company-access", entityId: `${email}:${a._id}` })).toBe(1);
  await grant(a._id, email, null, actor);
  expect(await roleForCompany({ companyId: a._id, email, actorId: employee._id })).toBeNull();
  expect(await ChangeLog.countDocuments({ entity: "company-access", entityId: `${email}:${a._id}` })).toBe(2);
});

test("a new membership refuses to activate unrelated global app roles", async () => {
  const a = await company();
  const { email } = await person();
  await DepartmentRole.create({ departmentSlug: "sales", email, role: "approver" });
  await expect(grant(a._id, email, "viewer")).rejects.toMatchObject({
    code: "LEGACY_ROLES_REQUIRE_REVIEW", status: 409,
  });
  expect(await SpCompanyMembership.countDocuments({ companyId: a._id, email })).toBe(0);
  expect(await DepartmentRole.countDocuments({ departmentSlug: "ppc", email })).toBe(0);
});

test("owner is unique within a company, not globally across companies", async () => {
  const [a, b] = await Promise.all([company(), company()]);
  const first = await person();
  const second = await person();
  await grant(a._id, first.email, "owner");
  await expect(grant(a._id, second.email, "owner")).rejects.toMatchObject({ code: "OWNER_EXISTS" });
  await grant(b._id, second.email, "owner");
  expect(await roleForCompany({ companyId: b._id, email: second.email })).toBe("owner");
});

test("Access Control names a one-company legacy grant before migration", async () => {
  const a = await company();
  const { email, employee } = await person();
  await SpCompanyMembership.create({ companyId: a._id, email, employeeRef: employee._id });
  await DepartmentRole.create({ departmentSlug: "ppc", email, role: "owner" });
  const before = await list();
  expect(before.legacy).toContainEqual({
    email, role: "owner", companyId: String(a._id), state: "SINGLE_COMPANY_COMPATIBILITY",
  });
  await grant(a._id, email, "owner");
  const after = await list();
  expect(after.legacy).toEqual([]);
  expect(after.grants).toEqual(expect.arrayContaining([
    expect.objectContaining({ email, companyId: String(a._id), role: "owner", isActive: true }),
  ]));
});

test("revoking a legacy-only PPC role writes a tombstone and an audit event", async () => {
  const a = await company();
  const { email, employee } = await person();
  await SpCompanyMembership.create({ companyId: a._id, email, employeeRef: employee._id });
  await DepartmentRole.create({ departmentSlug: "ppc", email, role: "viewer" });
  expect(await roleForCompany({ companyId: a._id, email, actorId: employee._id })).toBe("viewer");
  await grant(a._id, email, null);
  expect(await roleForCompany({ companyId: a._id, email, actorId: employee._id })).toBeNull();
  const event = await ChangeLog.findOne({ entity: "company-access", entityId: `${email}:${a._id}` }).lean();
  expect(event.before.role).toBe("viewer");
  expect(event.after.role).toBeNull();
});

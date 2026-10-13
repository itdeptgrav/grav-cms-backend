"use strict";

const mongoose = require("mongoose");
const Employee = require("../../models/Employee");
const DeptUser = require("../../models/Access/DeptUser");
const { resolveEmployee } = require("../home/employeeHome.service");
const { actorFrom, verifiedIdentity } = require("../access/appAccess.service");

const ACTIVE_EMPLOYEE = { isActive: { $ne: false }, status: { $ne: "inactive" } };
const EMPLOYEE_FIELDS = "firstName lastName name email biometricId identityId coworkEmployeeId profilePhoto.url department designation jobTitle";

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const cleanId = (value) => String(value || "").trim().toUpperCase();
const displayName = (record) => String(
  record?.name || [record?.firstName, record?.lastName].filter(Boolean).join(" ") || record?.email || "Employee",
).trim();

function employeeIdOf(employee) {
  return cleanId(employee?.biometricId || employee?.identityId || employee?.coworkEmployeeId);
}

function fromEmployee(employee) {
  const employeeId = employeeIdOf(employee);
  if (!employee || !employeeId) return null;
  return {
    actorKey: `employee:${employee._id}`,
    employeeId,
    name: displayName(employee),
    email: String(employee.email || "").toLowerCase(),
    photo: employee.profilePhoto?.url || null,
    department: employee.department || null,
    role: employee.designation || employee.jobTitle || null,
  };
}

/**
 * Stable credential owner derived from the same database-verified identity
 * used by application access. This deliberately does not require an HR badge:
 * Gmail belongs to the signed-in account, while a badge is required only when
 * that account addresses or receives GRAV-internal mail.
 */
async function resolveMailPrincipal(user) {
  const identity = await verifiedIdentity(actorFrom(user));
  if (!identity.ok) {
    const err = new Error("Your Mail identity is no longer active");
    err.status = identity.code === "UNAUTHENTICATED" ? 401 : 403;
    err.code = identity.code;
    throw err;
  }
  if (identity.kind === "employee") return { actorKey: `employee:${identity.record._id}` };
  if (identity.kind === "dept_user" && identity.record.employeeRef) {
    return { actorKey: `employee:${identity.record.employeeRef}` };
  }
  return { actorKey: `${identity.kind}:${identity.record._id}` };
}

async function resolveMailActor(user) {
  const resolved = await resolveEmployee(user);
  const employeeIdentity = fromEmployee(resolved.employee);
  if (employeeIdentity) return employeeIdentity;

  if (mongoose.Types.ObjectId.isValid(String(user?.id || ""))) {
    const deptUser = await DeptUser.findById(user.id)
      .select("name email employeeId isActive")
      .lean();
    const employeeId = cleanId(deptUser?.employeeId);
    if (deptUser?.isActive !== false && employeeId) {
      return {
        actorKey: `dept_user:${deptUser._id}`,
        employeeId,
        name: displayName(deptUser),
        email: String(deptUser.email || "").toLowerCase(),
        photo: null,
        department: null,
        role: null,
      };
    }
  }

  const err = new Error("Your account needs an employee ID before it can use internal mail");
  err.status = 409;
  err.code = "MAIL_EMPLOYEE_ID_REQUIRED";
  throw err;
}

async function findRecipientByEmployeeId(value) {
  const employeeId = cleanId(value);
  if (!employeeId) return null;
  const exact = new RegExp(`^${escapeRegex(employeeId)}$`, "i");
  const employees = await Employee.find({
    ...ACTIVE_EMPLOYEE,
    isDepartmentAccount: { $ne: true },
    $or: [{ biometricId: exact }, { identityId: exact }, { coworkEmployeeId: exact }],
  }).select(EMPLOYEE_FIELDS).limit(2).lean();
  if (employees.length === 1) return fromEmployee(employees[0]);
  if (employees.length > 1) {
    const err = new Error(`Employee ID ${employeeId} is assigned to more than one employee`);
    err.status = 409;
    err.code = "MAIL_EMPLOYEE_ID_AMBIGUOUS";
    throw err;
  }

  const users = await DeptUser.find({ employeeId: exact, isActive: { $ne: false } })
    .select("name email employeeId employeeRef")
    .limit(2)
    .lean();
  if (users.length !== 1) return null;
  if (users[0].employeeRef) {
    const linked = await Employee.findOne({ _id: users[0].employeeRef, ...ACTIVE_EMPLOYEE })
      .select(EMPLOYEE_FIELDS)
      .lean();
    const linkedIdentity = fromEmployee(linked);
    if (linkedIdentity) return linkedIdentity;
  }
  return {
    actorKey: `dept_user:${users[0]._id}`,
    employeeId,
    name: displayName(users[0]),
    email: String(users[0].email || "").toLowerCase(),
    photo: null,
    department: null,
    role: null,
  };
}

async function searchDirectory(query, limit = 10) {
  const text = String(query || "").trim().slice(0, 60);
  if (text.length < 2) return [];
  const rx = new RegExp(escapeRegex(text), "i");
  const rows = await Employee.find({
    ...ACTIVE_EMPLOYEE,
    isDepartmentAccount: { $ne: true },
    $or: [
      { firstName: rx }, { lastName: rx }, { name: rx },
      { biometricId: rx }, { identityId: rx }, { coworkEmployeeId: rx },
    ],
  }).select(EMPLOYEE_FIELDS).limit(Math.min(Number(limit) || 10, 20)).lean();
  return rows.map(fromEmployee).filter(Boolean);
}

module.exports = {
  cleanId, employeeIdOf, resolveMailPrincipal, resolveMailActor,
  findRecipientByEmployeeId, searchDirectory,
};

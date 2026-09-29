"use strict";
/**
 * EXPLOIT-FIRST — the real `/api/employees/all`, not a stub.
 *
 * The directory route selected the whole Employee document minus a handful of
 * names and sent it. The contract's response scrub removed salary, banking,
 * government identifiers and medical data — but a scrub is a DENYLIST, and a
 * denylist protects the fields somebody remembered. Everything else went out:
 * personal phone, home address, date of birth, family details, uploaded
 * document metadata, administrator-configured custom fields.
 *
 * This test saves an employee carrying every one of those, plus a field the
 * policy has never heard of, and asserts a directory viewer receives ONLY the
 * declared directory class. The unknown field is the important one: it stands
 * in for the column somebody adds to Employee next week, and it must be
 * withheld by default rather than published by default.
 */

const express = require("express");
const cookieParser = require("cookie-parser");
const mongoose = require("mongoose");

const {
  resetAccessCaches,
  makeDepartment,
  makeEmployee,
  grantHrRole,
  cmsToken,
  bearer,
} = require("./helpers");

const hrContract = require("../../Middlewear/hrContract");
const conditionalGet = require("../../middleware/conditionalGet");
const Employee = require("../../models/Employee");
const { DIRECTORY_FIELDS } = require("../../services/access/hrFieldPolicy");

let server, base, hr, sales;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/employees", conditionalGet({ minBytes: 1 }));
  app.use("/api/employees", hrContract());
  app.use("/api/employees", require("../../routes/HrRoutes/Employee-Section"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
});

/** Every private / restricted value that must not reach a directory viewer. */
const SECRETS = {
  phone: "9990001111",
  personalEmail: "asha@personal.test",
  alternatePhone: "8880002222",
  accountNumber: "1234567890",
  aadhar: "1111 2222 3333",
  pan: "ABCDE1234F",
  street: "12 Residency Road",
  spouse: "Ravi Rao",
  father: "Mohan",
  bloodGroup: "O+",
  custom: "CUSTOM-SECRET-VALUE",
  resume: "https://example.test/cv.pdf",
};

beforeEach(async () => {
  resetAccessCaches();
  hr = await makeDepartment("hr", "HR", "/hr/dashboard");
  sales = await makeDepartment("sales", "Sales", "/sales/dashboard");
  await grantHrRole("configured@grav.in", "viewer", "Someone");
  resetAccessCaches();

  const saved = await makeEmployee({
    biometricId: "GR0099",
    firstName: "Asha",
    lastName: "Rao",
    email: "asha@grav.in",
    designation: "Operator",
    department: "Cutting",
    workPhone: "0801234",
    status: "active",
    phone: SECRETS.phone,
    personalEmail: SECRETS.personalEmail,
    alternatePhone: SECRETS.alternatePhone,
    dateOfBirth: new Date("1995-04-01"),
    maritalStatus: "married",
    spouseName: SECRETS.spouse,
    fatherFirstName: SECRETS.father,
    bloodGroup: SECRETS.bloodGroup,
    isPhysicallyChallenged: false,
    address: { current: { street: SECRETS.street, city: "Bengaluru", pincode: "560025" } },
    salary: { gross: 45000 },
    bankDetails: { bankName: "SBI", accountNumber: SECRETS.accountNumber, ifscCode: "SBIN0001" },
    documents: {
      aadharNumber: SECRETS.aadhar,
      panNumber: SECRETS.pan,
      uanNumber: "100200300",
      resumeFile: { url: SECRETS.resume, name: "cv.pdf" },
    },
    personalCustomFields: [{ key: "emergencyContact", label: "Emergency contact", value: SECRETS.custom }],
    password: "$2a$10$hashhashhashhash",
    temporaryPassword: "Welcome@123",
  });

  /* A field the policy has never heard of — the column added next week.
     Written past the schema on purpose, which is exactly how it would arrive
     if somebody added it to Employee and nobody updated the allowlist. */
  await mongoose.connection
    .collection(Employee.collection.name)
    .updateOne({ _id: saved._id }, { $set: { anUnclassifiedNewField: "LEAKED-BY-DEFAULT" } });
});

async function hrUser(role) {
  const email = `${role}@grav.in`;
  await grantHrRole(email, role, role);
  const emp = await makeEmployee({ biometricId: `GR${role}`, email, accessDepartmentId: hr._id });
  resetAccessCaches();
  return cmsToken({ id: String(emp._id), email, employeeId: `GR${role}`, role: "hr_manager" });
}

async function getAll(token) {
  const res = await fetch(`${base}/api/employees/all?limit=50`, { headers: bearer(token) });
  const text = await res.text();
  return { status: res.status, text, body: text ? JSON.parse(text) : null };
}

describe("the real directory route", () => {
  test("a viewer receives ONLY the declared directory fields", async () => {
    const token = await hrUser("viewer");
    const r = await getAll(token);

    expect(r.status).toBe(200);
    const row = r.body.data.employees.find((e) => e.biometricId === "GR0099");
    expect(row).toBeTruthy();

    /* Nothing outside the directory allowlist, whatever it is called. */
    const extra = Object.keys(row).filter((k) => !DIRECTORY_FIELDS.includes(k));
    expect(extra).toEqual([]);

    /* And no value from the private or restricted classes anywhere in the
       response — the whole body, not just this row. */
    for (const [name, value] of Object.entries(SECRETS)) {
      expect({ name, leaked: r.text.includes(value) }).toEqual({ name, leaked: false });
    }
    expect(r.text).not.toMatch(/Welcome@123|\$2a\$10/);
  });

  test("a field nobody has classified is withheld by default", async () => {
    const token = await hrUser("viewer");
    const r = await getAll(token);
    expect(r.text).not.toMatch(/LEAKED-BY-DEFAULT/);
    expect(r.text).not.toMatch(/anUnclassifiedNewField/);
  });

  test("the row is still a usable directory entry", async () => {
    const token = await hrUser("viewer");
    const row = (await getAll(token)).body.data.employees.find((e) => e.biometricId === "GR0099");
    expect(row.firstName).toBe("Asha");
    expect(row.lastName).toBe("Rao");
    expect(row.designation).toBe("Operator");
    expect(row.department).toBe("Cutting");
    expect(row.email).toBe("asha@grav.in");
    expect(row.status).toBe("active");
  });

  test("the envelope, pagination and stats are unchanged", async () => {
    const token = await hrUser("viewer");
    const r = await getAll(token);
    expect(r.body.success).toBe(true);
    expect(r.body.data.pagination).toEqual(
      expect.objectContaining({
        currentPage: 1,
        totalPages: expect.any(Number),
        totalEmployees: expect.any(Number),
        hasNextPage: expect.any(Boolean),
        hasPrevPage: expect.any(Boolean),
      }),
    );
    expect(r.body.data.stats).toEqual(
      expect.objectContaining({ total: expect.any(Number), departmentStats: expect.any(Array) }),
    );
  });

  test("an approver sees compensation and an editor does not", async () => {
    const editor = await hrUser("editor");
    const approver = await hrUser("approver");

    const asEditor = await getAll(editor);
    expect(asEditor.text).not.toMatch(new RegExp(SECRETS.accountNumber));
    expect(asEditor.text).not.toMatch(/45000/);
    /* An editor DOES hold people.read.private, so the private class is theirs. */
    expect(asEditor.text).toMatch(new RegExp(SECRETS.phone));

    const asApprover = await getAll(approver);
    expect(asApprover.text).toMatch(new RegExp(SECRETS.accountNumber));
  });

  test("the CEO/management projection is the directory class too", async () => {
    const ceoDept = await makeDepartment("ceo", "CEO", "/ceo/dashboard");
    const emp = await makeEmployee({ biometricId: "GRCEO", email: "ceo@grav.in", accessDepartmentId: ceoDept._id });
    resetAccessCaches();
    const token = cmsToken({ id: String(emp._id), email: "ceo@grav.in", employeeId: "GRCEO", role: "ceo" });

    const r = await getAll(token);
    expect(r.status).toBe(200);
    for (const value of Object.values(SECRETS)) expect(r.text.includes(value)).toBe(false);
  });
});

describe("a protected value is not even loaded", () => {
  test("the query excludes what the caller may not read", async () => {
    /* Not just "not serialized": a restricted value that is loaded has already
       been read out of the database and, for salary, decrypted. */
    const { selectFor } = require("../../services/access/hrFieldPolicy");
    const { ROLE_TEMPLATES } = require("../../services/access/hrCapabilities");
    const viewerSelect = selectFor({ hrAuth: { capabilities: new Set(ROLE_TEMPLATES.hr_viewer) } });

    for (const field of ["salary", "bankDetails", "phone", "address", "dateOfBirth", "documents"]) {
      expect(viewerSelect).toContain(`-${field}`);
    }
  });

  test("with no contract in front of it, the route falls back to the NARROWEST class", async () => {
    /* Fail closed: a handler reached without the guard — a router mounted
       somewhere new, a test harness — must not answer with the whole record. */
    const { projectFor } = require("../../services/access/hrFieldPolicy");
    const out = projectFor({}, { firstName: "A", phone: "9", salary: { gross: 1 } });
    expect(out.firstName).toBe("A");
    expect(out.phone).toBeUndefined();
    expect(out.salary).toBeUndefined();
  });
});

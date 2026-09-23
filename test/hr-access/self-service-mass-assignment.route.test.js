"use strict";
/**
 * EXPLOIT-FIRST — `PUT /api/employee/profile` was a mass-assignment hole.
 *
 * The handler deleted fourteen named fields from `req.body` and applied
 * everything that was left. Everything the list did not name was written to the
 * employee's own record, and the list did not name:
 *
 *   accessDepartmentId   THE APPLICATION-ACCESS GRANT. Any employee holding the
 *                        mobile app could put the HR department's id here and
 *                        sign in to HR — or Accounting, or the CEO dashboard.
 *   salary, bankDetails  their own pay and bank account
 *   status, employmentType, designation, jobTitle, workShift
 *   documents            Aadhaar / PAN / UAN
 *   temporaryPassword
 *
 * Each test below sends the exploit and asserts two things: the request is
 * refused with a stable code, and the DATABASE IS UNCHANGED. The second is the
 * one that matters — a 4xx over a write that already happened is not a fix.
 */

const express = require("express");
const cookieParser = require("cookie-parser");

jest.mock("expo-server-sdk", () => ({
  Expo: class {
    static isExpoPushToken() { return false; }
    chunkPushNotifications() { return []; }
    sendPushNotificationsAsync() { return Promise.resolve([]); }
  },
}));

const {
  resetAccessCaches,
  makeDepartment,
  makeEmployee,
  appToken,
  bearer,
} = require("./helpers");

const hrContract = require("../../Middlewear/hrContract");
const Employee = require("../../models/Employee");

let server, base, hr, sales, me;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/employee", hrContract());
  app.use("/api/employee", require("../../routes/Employee_Routes/employeeAuth"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
});

beforeEach(async () => {
  resetAccessCaches();
  hr = await makeDepartment("hr", "HR", "/hr/dashboard");
  sales = await makeDepartment("sales", "Sales", "/sales/dashboard");
  me = await makeEmployee({
    biometricId: "GRSELF1",
    firstName: "Asha",
    lastName: "Rao",
    email: "asha@grav.in",
    phone: "9999999999",
    designation: "Operator",
    department: "Cutting",
    jobTitle: "Machine Operator",
    status: "active",
    employmentType: "full_time",
    accessDepartmentId: sales._id,
    salary: { gross: 30000 },
    bankDetails: { bankName: "SBI", accountNumber: "1111111111" },
    documents: { aadharNumber: "0000 0000 0000" },
  });
});

const token = () => appToken({ id: String(me._id), email: "asha@grav.in" });

async function put(body) {
  const res = await fetch(`${base}/api/employee/profile`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...bearer(token()) },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const reload = () => Employee.findById(me._id).lean();

describe("the exploit", () => {
  test("an employee cannot grant themselves an application by writing accessDepartmentId", async () => {
    const r = await put({ nickName: "Ash", accessDepartmentId: String(hr._id) });

    expect(r.status).toBe(403);
    expect(r.body.code).toBe("SELF_FIELD_NOT_EDITABLE");
    expect(r.body.fields).toContain("accessDepartmentId");

    const after = await reload();
    expect(String(after.accessDepartmentId)).toBe(String(sales._id));
    /* And the allowed field alongside it was NOT applied either — the payload
       is refused whole, so there is no half-written state. */
    expect(after.nickName || "").toBe("");
  });

  test("an employee cannot add themselves to an extra application", async () => {
    const r = await put({ additionalDepartmentIds: [String(hr._id)] });
    expect(r.status).toBe(403);
    expect((await reload()).additionalDepartmentIds).toEqual([]);
  });

  test("an employee cannot give themselves a pay rise", async () => {
    const before = await reload();
    const r = await put({ salary: { gross: 900000 } });

    expect(r.status).toBe(403);
    expect(r.body.fields).toContain("salary");
    expect((await reload()).salary.gross).toEqual(before.salary.gross);
  });

  test("an employee cannot rewrite their bank account", async () => {
    const r = await put({ bankDetails: { accountNumber: "2222222222" } });
    expect(r.status).toBe(403);
    expect((await reload()).bankDetails.accountNumber).toBe("1111111111");
  });

  test("an employee cannot promote themselves or change employment state", async () => {
    for (const payload of [
      { designation: "Head of HR" },
      { jobTitle: "Director" },
      { status: "inactive" },
      { employmentType: "full_time" },
      { department: "HR" },
      { dateOfJoining: "2015-01-01" },
      { primaryManager: { managerId: String(me._id) } },
      { workLocation: "Head Office" },
      { shift: "Night" },
    ]) {
      const r = await put(payload);
      expect({ payload, status: r.status }).toEqual({ payload, status: 403 });
    }

    const after = await reload();
    expect(after.designation).toBe("Operator");
    expect(after.jobTitle).toBe("Machine Operator");
    expect(after.status).toBe("active");
    expect(after.department).toBe("Cutting");
    expect(after.primaryManager?.managerId).toBeUndefined();
  });

  test("an employee cannot rewrite their statutory identifiers", async () => {
    const r = await put({ documents: { aadharNumber: "9999 9999 9999" } });
    expect(r.status).toBe(403);
    expect((await reload()).documents.aadharNumber).toBe("0000 0000 0000");
  });

  test("an employee cannot set a credential or an identity field", async () => {
    for (const payload of [
      { password: "hunter2" },
      { temporaryPassword: "letmein" },
      { biometricId: "GR0001" },
      { identityId: "SOMEONE-ELSE" },
      { isAdmin: true },
      { _id: "60c0000000000000000000ff" },
    ]) {
      const r = await put(payload);
      expect({ payload, status: r.status }).toEqual({ payload, status: 403 });
    }
    const after = await reload();
    expect(after.biometricId).toBe("GRSELF1");
    expect(after.temporaryPassword).toBeUndefined();
  });

  test("a Mongo operator smuggled into the body is refused", async () => {
    const r = await put({ $set: { accessDepartmentId: String(hr._id) } });
    expect(r.status).toBe(403);
    expect(String(await reload().then((e) => e.accessDepartmentId))).toBe(String(sales._id));
  });
});

describe("what an employee may still do", () => {
  test("their own personal details save normally", async () => {
    const r = await put({
      nickName: "Ash",
      maritalStatus: "married",
      spouseName: "Ravi",
      alternatePhone: "8888888888",
      personalEmail: "asha@personal.test",
      address: { current: { city: "Bengaluru", street: "1 Road" } },
      fatherFirstName: "Mohan",
    });

    expect(r.status).toBe(200);
    const after = await reload();
    expect(after.nickName).toBe("Ash");
    expect(after.spouseName).toBe("Ravi");
    expect(after.alternatePhone).toBe("8888888888");
    expect(after.address.current.city).toBe("Bengaluru");
    expect(after.fatherFirstName).toBe("Mohan");
  });

  test("the read-only extras the profile GET adds are ignored, not refused", async () => {
    /* A client that GETs the profile and PUTs it back sends `fullName`,
       `phoneNumber` and the pre-formatted dates. Refusing the save over a
       rendering convenience would be a security message for a non-security
       problem. */
    const r = await put({
      nickName: "Ash",
      fullName: "Asha Rao",
      phoneNumber: "9999999999",
      formattedDateOfBirth: "01/04/1995",
      employeeId: "GRSELF1",
      email: "somebody.else@grav.in",
      phone: "7777777777",
    });

    expect(r.status).toBe(200);
    const after = await reload();
    expect(after.nickName).toBe("Ash");
    /* Contact fields HR owns are ignored rather than applied — the behaviour
       the old denylist already had, kept deliberately: `email` is what a
       DepartmentRole grant is keyed on. */
    expect(after.email).toBe("asha@grav.in");
    expect(after.phone).toBe("9999999999");
  });

  test("an empty update says so rather than pretending to save", async () => {
    const r = await put({ fullName: "Asha Rao" });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("NO_EDITABLE_FIELDS");
  });

  test("the request body is never mutated in place", async () => {
    /* The old handler deleted keys from `req.body`, so the audit trail, a
       retry and the approval queue's stored copy all saw a body that was not
       the one the client sent. Proven through the policy directly, since the
       express copy is not reachable from here. */
    const { filterSelfProfileUpdate } = require("../../services/access/hrWritePolicy");
    const body = { nickName: "Ash", salary: { gross: 1 }, accessDepartmentId: "x" };
    const snapshot = JSON.parse(JSON.stringify(body));
    filterSelfProfileUpdate(body);
    expect(body).toEqual(snapshot);
  });
});

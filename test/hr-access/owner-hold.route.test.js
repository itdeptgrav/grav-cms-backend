"use strict";
/**
 * A NEW EMPLOYEE'S PAY, FROM SOMEBODY WHO MAY NOT SET PAY, GOES TO THE OWNER.
 *
 * The new-employee form always sends salary and bank details, and only the HR
 * owner holds `compensation.write`, so an approver or editor creating anybody
 * was refused outright: "You do not have permission to perform this action."
 * The owner's rule (5 Oct 2026): send it to the owner instead. The contract now
 * passes such a create through MARKED (`req.holdForOwner`); the department
 * guard holds it and only the owner may decide it.
 *
 * These pin the contract's half: what is marked, and that nothing else is.
 */

const express = require("express");
const cookieParser = require("cookie-parser");

const { resetAccessCaches, makeDepartment, makeEmployee, grantHrRole, cmsToken } = require("./helpers");
const hrContract = require("../../Middlewear/hrContract");

let server, base;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/employees", hrContract());
  app.use((req, res) => res.json({ reached: true, holdForOwner: req.holdForOwner || null }));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

async function as(role) {
  resetAccessCaches();
  await makeDepartment("hr", "HR", "/hr/dashboard");
  const emp = await makeEmployee({ firstName: role, email: `${role}@grav.in`, biometricId: `GR9${role.length}` });
  await grantHrRole(emp.email, role, role);
  resetAccessCaches();
  return cmsToken({ id: String(emp._id), email: emp.email, role: "hr_manager", userType: "hr" });
}

const create = (tok, body) =>
  fetch(`${base}/api/employees`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${tok}` },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, data: await r.json() }));

const NEW = { firstName: "New", lastName: "Joiner", department: "IT" };

describe("POST /api/employees — pay from a non-owner", () => {
  test("an approver's create WITH pay passes, marked for the owner", async () => {
    const r = await create(await as("approver"), { ...NEW, salary: { gross: 20000 } });
    expect(r.status).toBe(200);
    expect(r.data.holdForOwner).toMatchObject({ capability: "compensation.write" });
    expect(r.data.holdForOwner.fields).toContain("salary");
  });

  test("an editor's create WITH pay and bank details is marked the same way", async () => {
    const r = await create(await as("editor"), { ...NEW, salary: { gross: 20000 }, bankDetails: { bankName: "SBI" } });
    expect(r.status).toBe(200);
    expect(r.data.holdForOwner.fields).toEqual(expect.arrayContaining(["salary", "bankDetails"]));
  });

  test("a create WITHOUT pay is not marked", async () => {
    const r = await create(await as("editor"), NEW);
    expect(r.data.holdForOwner).toBeNull();
  });

  test("the owner's create is never marked — the owner sets pay", async () => {
    const r = await create(await as("owner"), { ...NEW, salary: { gross: 20000 } });
    expect(r.data.holdForOwner).toBeNull();
  });

  test("a viewer is still refused — the hold is for the pay gap only", async () => {
    const r = await create(await as("viewer"), { ...NEW, salary: { gross: 20000 } });
    expect(r.status).toBe(403);
  });

  test("an EDIT of an existing employee's pay is still refused, not held", async () => {
    const tok = await as("approver");
    const r = await fetch(`${base}/api/employees/507f1f77bcf86cd799439011`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${tok}` },
      body: JSON.stringify({ salary: { gross: 99999 } }),
    });
    expect(r.status).toBe(403);
    expect((await r.json()).requiredCapability).toBe("compensation.write");
  });
});

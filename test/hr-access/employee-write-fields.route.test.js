"use strict";
/**
 * EXPLOIT-FIRST — an HR employee write is several operations wearing one URL.
 *
 * `PUT /api/employees/:id` carries a corrected middle name, a transfer and a
 * salary revision. Authorising it by ROUTE means one capability decides all
 * three, and whichever is chosen is wrong for the other two. Before this pass
 * the route declared `people.write` + `employment.change`, so every HR editor
 * could rewrite anybody's salary — and nothing at all stopped an HR role from
 * writing `accessDepartmentId`, which is the platform's application-access
 * grant and is Access Control's to give, not HR's.
 *
 * Each test sends the payload and asserts the refusal AND that no part of a
 * mixed payload was applied.
 *
 * (14 Oct 2026, owner: no role tiers in the employee section) Every HR user —
 * viewer to owner — now writes pay, bank details and employment state on these
 * routes, and nothing is held for the owner. What is still refused, at every
 * HR role, is a field that is not HR's to write at all (an access grant, an
 * admin flag, a credential, an audit stamp); those tests are unchanged in
 * substance, and the "mixed payload" tests now pin the whole-request refusal
 * on such a field instead of on pay.
 */

const express = require("express");
const cookieParser = require("cookie-parser");

const {
  resetAccessCaches,
  makeDepartment,
  makeEmployee,
  grantHrRole,
  cmsToken,
  bearer,
} = require("./helpers");

const hrContract = require("../../Middlewear/hrContract");
const Employee = require("../../models/Employee");

let server, base, hr, sales, target;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/employees", hrContract());
  /* A stub, not the real router: what is under test is the CONTRACT's
     field-sensitive decision, which happens before any handler runs. The
     handler is represented by "the write would have happened here". */
  app.use("/api/employees", async (req, res) => {
    /* What the real chain does with a create the contract MARKED for the owner
       (pay from a non-owner, 5 Oct 2026): the department guard holds it, and
       the create handler refuses it as a backstop. Either way, nothing here
       is written. */
    if (req.holdForOwner) return res.status(202).json({ held: true, requiredRole: "owner", fields: req.holdForOwner.fields || [] });
    if (req.method !== "GET") {
      const patch = req.body?.updates || req.body || {};
      await Employee.updateOne({ _id: target._id }, { $set: patch });
    }
    res.json({ applied: true });
  });
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
  await grantHrRole("configured@grav.in", "viewer", "Someone");
  resetAccessCaches();
  target = await makeEmployee({
    biometricId: "GRTGT",
    firstName: "Target",
    email: "target@grav.in",
    designation: "Operator",
    accessDepartmentId: sales._id,
    salary: { gross: 30000 },
  });
});

async function hrUser(role) {
  const email = `${role}@grav.in`;
  await grantHrRole(email, role, role);
  const emp = await makeEmployee({ biometricId: `GR${role}`, email, accessDepartmentId: hr._id });
  resetAccessCaches();
  return cmsToken({ id: String(emp._id), email, employeeId: `GR${role}`, role: "hr_manager" });
}

async function send(method, path, token, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...bearer(token) },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const reload = () => Employee.findById(target._id).lean();

describe("access grants are never writable through an HR employee route", () => {
  test.each(["viewer", "editor", "approver", "owner"])(
    "an HR %s cannot assign an application grant through PUT /api/employees/:id",
    async (role) => {
      const token = await hrUser(role);
      const r = await send("PUT", `/api/employees/${target._id}`, token, {
        firstName: "Renamed",
        accessDepartmentId: String(hr._id),
      });

      expect(r.status).toBe(403);
      /* (14 Oct 2026, owner: no role tiers in the employee section) A viewer
         used to be refused for lacking people.write. Every HR role holds it
         here now, so every one of them — the viewer included — is refused
         because the FIELD is not writable here at all. */
      expect(r.body.code).toBe("HR_FIELD_NOT_WRITABLE");

      const after = await reload();
      expect(String(after.accessDepartmentId)).toBe(String(sales._id));
      expect(after.firstName).toBe("Target");
    },
  );

  test("nor through create, nor through bulk update", async () => {
    const token = await hrUser("owner");

    const created = await send("POST", "/api/employees", token, {
      firstName: "New",
      accessDepartmentId: String(hr._id),
    });
    expect(created.status).toBe(403);
    expect(created.body.code).toBe("HR_FIELD_NOT_WRITABLE");

    const bulk = await send("PATCH", "/api/employees/bulk-update", token, {
      employeeIds: [String(target._id)],
      updates: { additionalDepartmentIds: [String(hr._id)] },
    });
    expect(bulk.status).toBe(403);
    expect(bulk.body.code).toBe("HR_FIELD_NOT_WRITABLE");
    expect((await reload()).additionalDepartmentIds).toEqual([]);
  });

  test("nor an admin flag, a credential or an audit stamp", async () => {
    const token = await hrUser("owner");
    for (const updates of [
      { isAdmin: true },
      { password: "x" },
      { temporaryPassword: "x" },
      { tokenVersion: 0 },
      { createdBy: String(target._id) },
      { $set: { salary: { gross: 1 } } },
    ]) {
      const r = await send("PUT", `/api/employees/${target._id}`, token, updates);
      expect({ updates, status: r.status, code: r.body.code }).toEqual({
        updates, status: 403, code: "HR_FIELD_NOT_WRITABLE",
      });
    }
  });
});

describe("salary is written by every HR user — no owner hold", () => {
  /* (14 Oct 2026, owner: no role tiers in the employee section) Until today
     only an owner held compensation.write: an editor's pay went to the owner
     (held, 202) and a bulk pay change was refused. Every HR user now holds it
     on the employee routes, and the write is applied directly. */
  test("an editor's NEW employee with a salary is applied, not held", async () => {
    const token = await hrUser("editor");
    const r = await send("POST", "/api/employees", token, { firstName: "New", salary: { gross: 100000 } });
    expect({ status: r.status, applied: r.body.applied, held: r.body.held }).toEqual({
      status: 200, applied: true, held: undefined,
    });
  });

  test.each(["viewer", "editor", "approver"])(
    "an %s's pay and bank change is applied; so is a bulk pay change",
    async (role) => {
      const token = await hrUser(role);

      for (const body of [{ salary: { gross: 100000 } }, { bankDetails: { accountNumber: "1" } }]) {
        const r = await send("PUT", `/api/employees/${target._id}`, token, body);
        expect({ body, status: r.status, applied: r.body.applied }).toEqual({ body, status: 200, applied: true });
      }
      expect((await reload()).salary.gross).toBe(100000);

      const bulk = await send("PATCH", "/api/employees/bulk-update", token, {
        employeeIds: [String(target._id)],
        updates: { "salary.gross": 120000 },
      });
      expect({ status: bulk.status, applied: bulk.body.applied }).toEqual({ status: 200, applied: true });
      expect((await reload()).salary.gross).toBe(120000);
    },
  );

  test("an owner with compensation.write performs the same operation", async () => {
    const token = await hrUser("owner");
    const r = await send("PUT", `/api/employees/${target._id}`, token, {
      salary: { gross: 100000 },
    });
    expect(r.status).toBe(200);
    expect(r.body.applied).toBe(true);
  });

  test("a dotted bulk path is classified like the field it belongs to", async () => {
    /* `salary.gross` used to look like an unknown ordinary field to anything
       matching whole keys, so a bulk pay rise would have gone through on
       people.write. */
    const { classifyEmployeeWrite } = require("../../services/access/hrWritePolicy");
    const verdict = classifyEmployeeWrite({ "salary.gross": 1, "bankDetails.ifscCode": "x" });
    expect(verdict.capabilities).toContain("compensation.write");
  });
});

describe("employment state needs employment.change", () => {
  test("a viewer may transfer, promote or terminate", async () => {
    /* (14 Oct 2026, owner: no role tiers in the employee section) A viewer
       was refused each of these until today. */
    const token = await hrUser("viewer");
    for (const updates of [
      { department: "HR" },
      { designation: "Head" },
      { status: "inactive" },
      { primaryManager: { managerId: String(target._id) } },
    ]) {
      const r = await send("PUT", `/api/employees/${target._id}`, token, updates);
      expect({ updates, status: r.status }).toEqual({ updates, status: 200 });
    }
    expect((await reload()).designation).toBe("Head");
  });

  test("an editor holds employment.change and may transfer", async () => {
    const token = await hrUser("editor");
    const r = await send("PUT", `/api/employees/${target._id}`, token, { department: "HR" });
    expect(r.status).toBe(200);
  });

  test("an editor may still fix an ordinary personal field", async () => {
    /* The regression the field-sensitive rule prevents in the OTHER direction:
       declaring the route at `employment.change` would have stopped an editor
       correcting a middle name. */
    const token = await hrUser("editor");
    const r = await send("PUT", `/api/employees/${target._id}`, token, { middleName: "Kumar" });
    expect(r.status).toBe(200);
    expect((await reload()).middleName).toBe("Kumar");
  });
});

describe("a mixed payload writes nothing at all", () => {
  /* (14 Oct 2026, owner: no role tiers in the employee section) These used a
     salary as the field that held the whole request for the owner. Pay is no
     longer held, so the property — a payload mixing an allowed change with a
     disallowed one is decided WHOLE, and no part of it is written — is pinned
     on a field no HR role may write: the access-department grant. */
  test.each(["viewer", "editor", "owner"])(
    "one field that is not HR's refuses the WHOLE request from an %s — nothing is written",
    async (role) => {
      const token = await hrUser(role);
      const before = await reload();

      const r = await send("PUT", `/api/employees/${target._id}`, token, {
        middleName: "Kumar",                 // allowed
        nickName: "T",                       // allowed
        salary: { gross: 999999 },           // allowed now, to every HR user
        accessDepartmentId: String(hr._id),  // Access Control's, never HR's
      });

      expect({ status: r.status, code: r.body.code }).toEqual({ status: 403, code: "HR_FIELD_NOT_WRITABLE" });
      const after = await reload();
      expect(after.middleName).toBe(before.middleName);
      expect(after.nickName).toBe(before.nickName);
      expect(after.salary.gross).toEqual(before.salary.gross);
      expect(String(after.accessDepartmentId)).toBe(String(sales._id));
    },
  );

  test("the refusal names the fields that caused it, and nothing else", async () => {
    const token = await hrUser("editor");
    const r = await send("PUT", `/api/employees/${target._id}`, token, {
      middleName: "Kumar",
      salary: { gross: 1 },
      accessDepartmentId: String(hr._id),
    });
    expect(r.status).toBe(403);
    expect(r.body.fields).toEqual(["accessDepartmentId"]);
    /* The caller's own request echoed back — it says nothing about the record. */
    expect(JSON.stringify(r.body)).not.toMatch(/target@grav\.in|GRTGT|30000/);
  });
});

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
      /* A viewer is refused for lacking people.write; everybody else is
         refused because the FIELD is not writable here at all. Both are a
         refusal, and neither writes. */
      expect(["HR_FIELD_NOT_WRITABLE", "HR_MISSING_CAPABILITY"]).toContain(r.body.code);

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

describe("salary needs compensation.write, and only an owner has it", () => {
  test("an editor cannot create, update or bulk-update a salary", async () => {
    const token = await hrUser("editor");

    for (const [method, path, body] of [
      ["POST", "/api/employees", { firstName: "New", salary: { gross: 100000 } }],
      ["PUT", `/api/employees/${target._id}`, { salary: { gross: 100000 } }],
      ["PUT", `/api/employees/${target._id}`, { bankDetails: { accountNumber: "1" } }],
      ["PATCH", "/api/employees/bulk-update", {
        employeeIds: [String(target._id)],
        updates: { "salary.gross": 100000 },
      }],
    ]) {
      const r = await send(method, path, token, body);
      expect({ path, status: r.status, code: r.body.code }).toEqual({
        path, status: 403, code: "HR_MISSING_CAPABILITY",
      });
      expect(r.body.requiredCapability).toBe("compensation.write");
    }

    expect((await reload()).salary.gross).not.toBe(100000);
  });

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
  test("a viewer cannot transfer, promote or terminate", async () => {
    const token = await hrUser("viewer");
    for (const updates of [
      { department: "HR" },
      { designation: "Head" },
      { status: "inactive" },
      { primaryManager: { managerId: String(target._id) } },
    ]) {
      const r = await send("PUT", `/api/employees/${target._id}`, token, updates);
      expect({ updates, status: r.status }).toEqual({ updates, status: 403 });
    }
    expect((await reload()).designation).toBe("Operator");
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
  test("one refused field refuses the whole request", async () => {
    const token = await hrUser("editor");
    const before = await reload();

    const r = await send("PUT", `/api/employees/${target._id}`, token, {
      middleName: "Kumar",          // allowed
      nickName: "T",                // allowed
      salary: { gross: 999999 },    // needs compensation.write
    });

    expect(r.status).toBe(403);
    const after = await reload();
    expect(after.middleName).toBe(before.middleName);
    expect(after.nickName).toBe(before.nickName);
    expect(after.salary.gross).toEqual(before.salary.gross);
  });

  test("the refusal names the fields that caused it, and nothing else", async () => {
    const token = await hrUser("editor");
    const r = await send("PUT", `/api/employees/${target._id}`, token, {
      middleName: "Kumar",
      salary: { gross: 1 },
    });
    expect(r.body.fields).toEqual(["salary"]);
    /* The caller's own request echoed back — it says nothing about the record. */
    expect(JSON.stringify(r.body)).not.toMatch(/target@grav\.in|GRTGT|30000/);
  });
});

"use strict";
/**
 * 11, AT THE WIRE — a protected value is not serialized to somebody without the
 * capability, whatever the handler behind the guard decided to return.
 *
 * `req.hrAuth.project` is the allowlist a handler should use. This is the floor
 * underneath it: twenty HR routers select their own fields, and a capability
 * gate that lets the right person through still has to answer for what the
 * handler serialized. The stub below is deliberately the WORST case — it
 * returns the whole employee document, salary, bank account, Aadhaar, blood
 * group, password hash and reset password included, exactly as an
 * uninstrumented `.find()` would.
 *
 * The ETag ordering is tested here too, because getting it wrong is a
 * disclosure and not a caching bug: if `conditionalGet` hashed the body before
 * the scrub, two callers with different capabilities would share an ETag and a
 * 304 could hand one of them the other's body.
 *
 * (14 Oct 2026, owner: no role tiers in the employee section) On the employee
 * routes (/api/employees/*) every HR user now receives the same body — pay,
 * bank details, identifiers and medical fields included — so the "a viewer
 * gets less" assertions there became "a viewer gets it all, never a
 * credential", and the tier-separation assertions moved to routes outside the
 * section (attendance, leaves) where the tiers still apply. The CEO projection
 * is not an HR user and still receives none of it, on the employee routes too.
 */

const express = require("express");
const cookieParser = require("cookie-parser");

const {
  resetAccessCaches,
  makeDepartment,
  makeEmployee,
  grantHrRole,
  cmsToken,
  appToken,
  bearer,
} = require("./helpers");

const hrContract = require("../../Middlewear/hrContract");
const conditionalGet = require("../../middleware/conditionalGet");

let server, base, hr, sales, fat;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());

  /* The server.js order, exactly: conditionalGet first, the contract second, so
     the contract's scrub is the OUTER wrapper. */
  for (const prefix of ["/api/hr", "/hr", "/api/employees"]) {
    app.use(prefix, conditionalGet({ minBytes: 1 }));
    app.use(prefix, hrContract());
  }
  app.use("/api/employee", hrContract());

  app.use((req, res) => res.json({ success: true, data: fat }));

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

  fat = {
    _id: "60c0000000000000000000aa",
    firstName: "Asha",
    designation: "Operator",
    salary: { gross: "enc:45000", netSalary: "enc:41000" },
    salaryCustomFields: [{ label: "Bonus", value: "enc:1000" }],
    bankDetails: { bankName: "SBI", accountNumber: "1234567890", ifscCode: "SBIN0001" },
    documents: {
      aadharNumber: "1111 2222 3333",
      panNumber: "ABCDE1234F",
      uanNumber: "100200300",
      pfNumber: "PF/1",
      esicNumber: "ESI/1",
      resumeFile: { url: "https://example.test/cv.pdf" },
    },
    bloodGroup: "O+",
    isPhysicallyChallenged: false,
    password: "$2a$10$hashhashhash",
    temporaryPassword: "Welcome@123",
  };
});

async function hrUser(role) {
  const email = `${role}@grav.in`;
  await grantHrRole(email, role, role);
  const emp = await makeEmployee({ biometricId: `GR${role}`, email, accessDepartmentId: hr._id });
  resetAccessCaches();
  return cmsToken({ id: String(emp._id), email, employeeId: `GR${role}`, role: "hr_manager" });
}

async function post(path, token, body = {}) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...bearer(token) },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text, body: text ? JSON.parse(text) : null };
}

async function get(path, token, headers = {}) {
  const res = await fetch(`${base}${path}`, { headers: { ...bearer(token), ...headers } });
  const etag = res.headers.get("etag");
  const text = await res.text();
  return { status: res.status, etag, text, body: text ? JSON.parse(text) : null };
}

describe("the response scrub", () => {
  test("a viewer's response OUTSIDE the employee section carries no protected value", async () => {
    /* (14 Oct 2026, owner: no role tiers in the employee section) This was
       pinned on /api/employees/all, which now gives a viewer everything. The
       floor is unchanged everywhere else, so it is pinned on attendance. */
    const token = await hrUser("viewer");
    const r = await get("/hr/attendance/daily", token);

    expect(r.status).toBe(200);
    expect(r.text).not.toMatch(/45000|1234567890|1111 2222 3333|ABCDE1234F|Welcome@123|\$2a\$10/);
    expect(r.body.data.salary).toBeUndefined();
    expect(r.body.data.bankDetails).toBeUndefined();
    expect(r.body.data.documents.aadharNumber).toBeUndefined();
    expect(r.body.data.bloodGroup).toBeUndefined();
    expect(r.body.data.password).toBeUndefined();
    expect(r.body.data.temporaryPassword).toBeUndefined();

    /* Still a usable directory row, and the uploaded file survives even though
       the government number beside it in the same sub-document does not. */
    expect(r.body.data.firstName).toBe("Asha");
    expect(r.body.data.documents.resumeFile.url).toBe("https://example.test/cv.pdf");
  });

  test.each(["viewer", "editor", "approver", "owner"])(
    "an HR %s receives the whole employee — pay, bank, identifiers, medical — and never a credential",
    async (role) => {
      /* (14 Oct 2026, owner: no role tiers in the employee section) Until today
         a viewer got no pay here. */
      const token = await hrUser(role);
      for (const path of ["/api/employees/all", "/api/employees/60c0000000000000000000aa"]) {
        const r = await get(path, token);
        expect({ path, status: r.status }).toEqual({ path, status: 200 });
        expect(r.body.data.salary.gross).toBe("enc:45000");
        expect(r.body.data.salaryCustomFields[0].value).toBe("enc:1000");
        expect(r.body.data.bankDetails.accountNumber).toBe("1234567890");
        expect(r.body.data.documents.aadharNumber).toBe("1111 2222 3333");
        expect(r.body.data.documents.panNumber).toBe("ABCDE1234F");
        expect(r.body.data.bloodGroup).toBe("O+");
        /* The credential floor is not part of "everything". */
        expect(r.body.data.password).toBeUndefined();
        expect(r.body.data.temporaryPassword).toBeUndefined();
      }
    },
  );

  test("a viewer still gets no pay on a route outside the employee section", async () => {
    /* (14 Oct 2026, owner: no role tiers in the employee section) The
       viewer's widened reads are for the employee routes only. */
    const v = await get("/api/hr/leaves", await hrUser("viewer"));
    expect(v.status).toBe(200);
    expect(v.body.data?.salary).toBeUndefined();
    expect(v.body.data?.bankDetails).toBeUndefined();
  });

  test("the CEO projection receives no pay, bank detail or identifier on the employee routes", async () => {
    /* (14 Oct 2026, owner: no role tiers in the employee section) The CEO
       projection is not an HR user, so the section's capabilities are not
       given to it: the directory it reads is scrubbed as before. */
    const ceo = await makeDepartment("ceo", "CEO", "/ceo/dashboard");
    const emp = await makeEmployee({ biometricId: "GRCEO", email: "cyra@grav.in", accessDepartmentId: ceo._id });
    resetAccessCaches();
    const token = cmsToken({ id: String(emp._id), email: "cyra@grav.in", employeeId: "GRCEO", role: "ceo" });

    const r = await get("/api/employees/all", token);
    expect(r.status).toBe(200);
    expect(r.text).not.toMatch(/45000|enc:1000|1234567890|1111 2222 3333|ABCDE1234F|Welcome@123|\$2a\$10/);
    expect(r.body.data.salary).toBeUndefined();
    expect(r.body.data.bankDetails).toBeUndefined();
    expect(r.body.data.documents.aadharNumber).toBeUndefined();
    expect(r.body.data.bloodGroup).toBeUndefined();
    expect(r.body.data.firstName).toBe("Asha");

    /* And the private record itself is not the projection's to read. */
    expect((await get("/api/employees/60c0000000000000000000aa", token)).status).toBe(403);
  });

  test("an approver gets pay, and still never a credential", async () => {
    const token = await hrUser("approver");
    const r = await get("/api/hr/payslip/GR0001", token);

    expect(r.body.data.salary.gross).toBe("enc:45000");
    expect(r.body.data.bankDetails.accountNumber).toBe("1234567890");
    expect(r.body.data.password).toBeUndefined();
    expect(r.body.data.temporaryPassword).toBeUndefined();
  });

  test("an employee reads their OWN pay without a compensation capability", async () => {
    const me = await makeEmployee({ biometricId: "GRME", email: "me@grav.in", accessDepartmentId: sales._id });
    const token = appToken({ id: String(me._id), email: "me@grav.in" });
    const r = await get("/api/employee/salary", token);

    expect(r.status).toBe(200);
    expect(r.body.data.salary.gross).toBe("enc:45000");
    /* Their own record, still not their own password hash. */
    expect(r.body.data.password).toBeUndefined();
    expect(r.body.data.temporaryPassword).toBeUndefined();
  });

  test("credential administration is the ONE place a generated password may be returned", async () => {
    const token = await hrUser("owner");

    /* The ONE route: the operation whose output IS a one-time credential. */
    const reset = await post("/api/hr/password-management/reset-password/employee/abc", token);
    expect(reset.body.data.temporaryPassword).toBe("Welcome@123");
    /* Never the stored hash, even here. */
    expect(reset.body.data.password).toBeUndefined();

    /* A LOOKUP in the same family holds the same capability and gets nothing —
       the opt-in is by declaration name, not by capability. */
    const lookup = await get("/api/hr/password-management/user/employee/abc", token);
    expect(lookup.body.data.temporaryPassword).toBeUndefined();

    /* And nowhere else, for the same person. */
    const elsewhere = await get("/api/employees/60c0000000000000000000aa", token);
    expect(elsewhere.body.data.temporaryPassword).toBeUndefined();
  });
});

describe("the ETag covers what the caller actually receives", () => {
  /* The route is one BOTH people may read — so the only thing that differs
     between their two responses is what the scrub removed, which is exactly
     what the ETag has to notice.

     (14 Oct 2026, owner: no role tiers in the employee section) This used
     /api/employees/all with a viewer and an approver. Every HR tier now gets
     the same body there, so the same ETag is correct and discloses nothing
     (pinned below). The separation is pinned on /api/hr/leaves, where the
     tiers still differ, and on the employee directory between the CEO
     projection and an HR user, which still differ.

     Asserted as a STRONG tag (no `W/` prefix) because Express attaches a weak
     one of its own to any res.send; matching on the strong form is what proves
     the tag under test is conditionalGet's, computed over the scrubbed body. */
  const strong = (tag) => typeof tag === "string" && tag.startsWith('"');

  async function ceoUser() {
    const ceo = await makeDepartment("ceo", "CEO", "/ceo/dashboard");
    const emp = await makeEmployee({ biometricId: "GRCEO", email: "cyra@grav.in", accessDepartmentId: ceo._id });
    resetAccessCaches();
    return cmsToken({ id: String(emp._id), email: "cyra@grav.in", employeeId: "GRCEO", role: "ceo" });
  }

  test("two capability levels do not share an ETag for the same route", async () => {
    const viewer = await hrUser("viewer");
    const approver = await hrUser("approver");

    const a = await get("/api/hr/leaves", approver);
    const v = await get("/api/hr/leaves", viewer);

    expect(strong(a.etag)).toBe(true);
    expect(strong(v.etag)).toBe(true);
    expect(v.etag).not.toBe(a.etag);
    /* And the reason they differ is the thing that must not leak. */
    expect(a.text).toMatch(/1234567890/);
    expect(v.text).not.toMatch(/1234567890/);
  });

  test("the CEO projection and an HR user do not share an ETag on the employee directory", async () => {
    const viewer = await hrUser("viewer");
    const ceo = await ceoUser();

    const h = await get("/api/employees/all", viewer);
    const c = await get("/api/employees/all", ceo);

    expect(strong(h.etag)).toBe(true);
    expect(strong(c.etag)).toBe(true);
    expect(c.etag).not.toBe(h.etag);
    expect(h.text).toMatch(/1234567890/);
    expect(c.text).not.toMatch(/1234567890/);
  });

  test("every HR tier gets the same employee directory, so the same ETag", async () => {
    /* Not a leak: the bodies are identical byte for byte, which is what the
       owner asked for. */
    const v = await get("/api/employees/all", await hrUser("viewer"));
    const a = await get("/api/employees/all", await hrUser("approver"));
    expect(v.text).toBe(a.text);
    expect(v.etag).toBe(a.etag);
  });

  test("replaying an approver's ETag as a viewer does NOT get a 304", async () => {
    const viewer = await hrUser("viewer");
    const approver = await hrUser("approver");

    const a = await get("/api/hr/leaves", approver);
    const replay = await get("/api/hr/leaves", viewer, { "If-None-Match": a.etag });

    expect(replay.status).toBe(200);
    expect(replay.text).not.toMatch(/1234567890|45000/);
  });

  test("replaying an HR user's ETag as the CEO projection does NOT get a 304", async () => {
    const viewer = await hrUser("viewer");
    const h = await get("/api/employees/all", viewer);
    const replay = await get("/api/employees/all", await ceoUser(), { "If-None-Match": h.etag });

    expect(replay.status).toBe(200);
    expect(replay.text).not.toMatch(/1234567890|45000/);
  });

  test("a caller's own ETag still gets a 304", async () => {
    const viewer = await hrUser("viewer");
    const first = await get("/api/employees/all", viewer);
    const second = await get("/api/employees/all", viewer, { "If-None-Match": first.etag });
    expect(second.status).toBe(304);
    expect(second.text).toBe("");
  });
});

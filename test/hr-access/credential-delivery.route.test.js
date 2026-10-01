"use strict";
/**
 * EXPLOIT-FIRST — the bulk password dump.
 *
 * `POST /api/hr/password-management/bulk-reset` reset every selected account to
 * the default derived from that person's mobile number and returned the
 * PLAINTEXT for each one. Twelve selected employees meant twelve working
 * credentials in a single response, and from there in whatever log, proxy cache
 * or screenshot it reached.
 *
 * The contract's scrub did not catch it twice over: `newPassword` is not an
 * Employee field, so no field denylist saw it; and credential delivery was
 * enabled for anything holding `security.credentials.manage`, which is the
 * whole password-management family — every list, lookup and sync included.
 *
 * Delivery is now opted into BY DECLARATION NAME, by the one operation whose
 * output is a one-time credential.
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
const { DECLARATIONS } = require("../../services/access/hrRouteContract");

let server, base, hr, payload;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/hr", hrContract());
  app.use("/api/employees", hrContract());
  /* The worst case a handler in this family could return. */
  app.use((req, res) => res.json({ success: true, data: payload }));

  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
});

beforeEach(async () => {
  resetAccessCaches();
  hr = await makeDepartment("hr", "HR", "/hr/dashboard");
  await grantHrRole("configured@grav.in", "viewer", "Someone");
  resetAccessCaches();

  payload = {
    temporaryPassword: "Temp@2026",
    newPassword: "9990001111",
    password: "$2a$10$hashhashhash",
    passwordHash: "$2a$10$otherhash",
    defaultPassword: "9990002222",
    successful: [
      { userId: "1", name: "Asha", newPassword: "9990001111" },
      { userId: "2", name: "Ravi", newPassword: "9990002222", passwordHash: "$2a$10$x" },
    ],
    nested: { deep: { generatedPassword: "Gen@2026", plainPassword: "Plain@2026" } },
    /* Not a credential — a signed short-lived document link. Must survive. */
    token: "signed-link-token",
    downloadUrl: "https://example.test/doc?sig=abc",
  };
});

async function owner() {
  await grantHrRole("owner@grav.in", "owner", "Owner");
  const emp = await makeEmployee({ biometricId: "GROWN", email: "owner@grav.in", accessDepartmentId: hr._id });
  resetAccessCaches();
  return cmsToken({ id: String(emp._id), email: "owner@grav.in", employeeId: "GROWN", role: "hr_manager" });
}

async function call(method, path, token) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...bearer(token) },
    ...(method === "GET" ? {} : { body: "{}" }),
  });
  const text = await res.text();
  return { status: res.status, text, body: text ? JSON.parse(text) : null };
}

const CREDENTIALS = [
  "Temp@2026", "9990001111", "9990002222", "$2a$10$hashhashhash",
  "$2a$10$otherhash", "$2a$10$x", "Gen@2026", "Plain@2026",
];

describe("no route in the family leaks a credential", () => {
  test.each([
    ["GET", "/api/hr/password-management/users", "the list"],
    ["GET", "/api/hr/password-management/user/employee/abc", "a lookup"],
    ["GET", "/api/hr/password-management/sync-dept-logins", "the sync read"],
    ["POST", "/api/hr/password-management/sync-dept-logins", "the sync write"],
    ["POST", "/api/hr/password-management/bulk-reset", "the BULK reset"],
    ["PATCH", "/api/hr/password-management/change-password/employee/abc", "an HR-set password"],
  ])("%s %s (%s) returns no credential material", async (method, path) => {
    const token = await owner();
    const r = await call(method, path, token);

    expect(r.status).toBe(200);
    for (const secret of CREDENTIALS) {
      expect({ path, secret, leaked: r.text.includes(secret) }).toEqual({ path, secret, leaked: false });
    }
    /* Not just the values — the keys are gone, at every depth and inside
       arrays. */
    for (const key of [
      "temporaryPassword", "newPassword", "password", "passwordHash",
      "defaultPassword", "generatedPassword", "plainPassword",
    ]) {
      expect({ path, key, present: r.text.includes(`"${key}"`) }).toEqual({ path, key, present: false });
    }
  });

  test("the bulk reset still reports who it reset, and their status", async () => {
    const token = await owner();
    const r = await call("POST", "/api/hr/password-management/bulk-reset", token);
    expect(r.body.data.successful[0].userId).toBe("1");
    expect(r.body.data.successful[0].name).toBe("Asha");
  });

  test("a signed document link is NOT mistaken for a credential", async () => {
    /* The reason the rule is an exact list of names rather than a pattern:
       anything matching /token|secret/ would strip the short-lived link
       `/api/hr/documents/:id/link` exists to return. */
    const token = await owner();
    const r = await call("GET", "/api/hr/password-management/users", token);
    expect(r.body.data.token).toBe("signed-link-token");
    expect(r.body.data.downloadUrl).toBe("https://example.test/doc?sig=abc");
  });
});

describe("the one operation that may deliver one", () => {
  test("reset-password returns the generated password — and nothing else", async () => {
    const token = await owner();
    const r = await call("POST", "/api/hr/password-management/reset-password/employee/abc", token);

    expect(r.body.data.temporaryPassword).toBe("Temp@2026");
    /* The stored hash is never deliverable, not even here. */
    expect(r.body.data.password).toBeUndefined();
    expect(r.body.data.passwordHash).toBeUndefined();
    expect(r.text).not.toMatch(/9990001111|Gen@2026|Plain@2026/);
  });

  test("exactly ONE declaration in the whole contract opts in", async () => {
    const optedIn = DECLARATIONS.filter((d) => d.credentialDelivery === true);
    expect(optedIn.map((d) => `${d.method} ${d.path}`)).toEqual([
      "POST /api/hr/password-management/reset-password/:userType/:id",
    ]);
  });

  test("holding the capability is NOT what enables delivery", async () => {
    /* Every route in the family requires `security.credentials.manage`. If the
       flag were derived from the capability, all of them would deliver. */
    const family = DECLARATIONS.filter((d) => d.path.startsWith("/api/hr/password-management"));
    expect(family.length).toBeGreaterThan(5);
    expect(family.every((d) => d.capabilities.includes("security.credentials.manage"))).toBe(true);
    expect(family.filter((d) => d.credentialDelivery).length).toBe(1);
  });
});

describe("an ordinary HR response never carries one either", () => {
  test("an employee read strips every credential name", async () => {
    const token = await owner();
    const r = await call("GET", "/api/employees/60c0000000000000000000aa", token);
    for (const secret of CREDENTIALS) expect(r.text.includes(secret)).toBe(false);
  });
});

describe("the handler itself no longer builds one", () => {
  test("bulk-reset assembles identifiers and status, not passwords", () => {
    /* Defence in depth: the scrub removes it on the way out, and the handler
       does not put it there in the first place — so a future route that
       forgets the contract still cannot dump it. */
    const src = require("fs").readFileSync(
      require("path").join(__dirname, "../../routes/HrRoutes/Passwordmanagement.js"),
      "utf8",
    );
    const bulk = src.slice(src.indexOf('router.post("/bulk-reset"'), src.indexOf('router.get("/sync-dept-logins"'));
    /* Matched on the RESULT ROW being pushed, not on the word appearing
       anywhere: the comment above the fixed line quotes the old code on
       purpose, so that a future reader knows what was there. */
    expect(bulk).not.toMatch(/^\s*newPassword:\s*defaultPassword,\s*$/m);
    expect(bulk).toMatch(/reset:\s*true/);
  });
});

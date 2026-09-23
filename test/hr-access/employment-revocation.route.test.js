"use strict";
/**
 * EXPLOIT-FIRST — revocation that only worked when a test helped it.
 *
 * The previous revocation suite proved the RESOLVER: it updated the database
 * directly and then called `invalidateHrAuthorization()` itself. Production
 * callers do not do that. HR deactivating somebody through the real endpoint
 * left the cached decision in place, so the person who had just been switched
 * off kept their HR session for the rest of the thirty-second window with the
 * token already in their browser.
 *
 * NOTHING IN THIS FILE CALLS AN INVALIDATION HELPER. Every test:
 *
 *   1. resolves the employee as an authorised HR actor, so the answer is cached;
 *   2. deactivates them through the REAL production route;
 *   3. makes the very next request with the SAME already-issued token.
 *
 * If the route does not invalidate, step 3 succeeds and the test fails.
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
const { resolveHrActor } = require("../../services/access/hrAuthorization");
const Employee = require("../../models/Employee");

let server, base, hr, sales;
let hrOwnerToken, victim, victimToken, victimClaims;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/employees", hrContract());
  app.use("/api/employees", require("../../routes/HrRoutes/Employee-Section"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
});

beforeEach(async () => {
  /* The ONLY reset in this file, and it is setup: it clears state left by the
     previous test, before anything under test has run. */
  resetAccessCaches();
  hr = await makeDepartment("hr", "HR", "/hr/dashboard");
  sales = await makeDepartment("sales", "Sales", "/sales/dashboard");

  /* The HR owner who performs the deactivation. */
  await grantHrRole("owner@grav.in", "owner", "Owner");
  const owner = await makeEmployee({
    biometricId: "GROWN", email: "owner@grav.in", accessDepartmentId: hr._id,
  });
  hrOwnerToken = cmsToken({
    id: String(owner._id), email: "owner@grav.in", employeeId: "GROWN",
    role: "hr_manager", userType: "hr",
  });

  /* The HR user who is about to be switched off — and whose token is already
     issued and sitting in their browser. */
  await grantHrRole("victim@grav.in", "approver", "Victim");
  victim = await makeEmployee({
    biometricId: "GRVIC", email: "victim@grav.in", accessDepartmentId: hr._id,
    firstName: "Vic", lastName: "Tim", status: "active", isActive: true,
  });
  victimClaims = {
    id: String(victim._id), email: "victim@grav.in", employeeId: "GRVIC",
    role: "hr_manager", userType: "hr",
  };
  victimToken = cmsToken(victimClaims);

  resetAccessCaches();
});

async function directoryAs(token) {
  const res = await fetch(`${base}/api/employees/all`, { headers: bearer(token) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function send(method, path, token, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...bearer(token) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

/** Step 1 — get the decision into the cache, as a real session would. */
async function warmTheCache() {
  const r = await directoryAs(victimToken);
  expect(r.status).toBe(200);
}

/**
 * The resolved actor for the victim's session, by OBJECT IDENTITY.
 *
 * "The next request returned 200" does not distinguish a surviving cache entry
 * from one that was thrown away and rebuilt — both answer 200. The resolver
 * hands back the *same object* when it is served from cache and a new one when
 * it recomputes, so `toBe` is the observable that tells them apart. It needs no
 * new API, reaches through no HTTP response, and exposes no cache state.
 *
 * The claims below are the ones `hrContract::seedIdentity` derives from the
 * victim's token, so this resolves under the same cache key that request did.
 */
async function actorForVictim() {
  return resolveHrActor({ ...victimClaims });
}

describe("PUT /api/employees/:id", () => {
  test("deactivating through the real route revokes on the NEXT request", async () => {
    await warmTheCache();

    const write = await send("PUT", `/api/employees/${victim._id}`, hrOwnerToken, {
      status: "inactive",
      isActive: false,
    });
    expect(write.status).toBe(200);

    const after = await directoryAs(victimToken);
    expect(after.status).toBe(403);
    expect(after.body.code).toBe("HR_NO_APPLICATION_ACCESS");
  });

  test("an employment-type change REBUILDS the cached actor — it does not revoke", async () => {
    /* Employment type is an eligibility field, so the write has to drop the
       cached decision. It does not remove HR access: this employee is still
       active, and what changes is which population they belong to. So the
       assertion is about the actor being RECOMPUTED, not about a refusal —
       and "the next request returned 200" cannot show that, because a cache
       that was cleared and rebuilt answers 200 too. Object identity can. */
    await warmTheCache();
    const before = await actorForVictim();

    const write = await send("PUT", `/api/employees/${victim._id}`, hrOwnerToken, {
      employmentType: "intern",
    });
    expect(write.status).toBe(200);

    const after = await actorForVictim();
    expect(after).not.toBe(before);

    /* Rebuilt, not revoked — they are still an active employee with an HR
       grant, so the new answer is the same answer computed again. */
    expect(after.hasHrApplicationAccess).toBe(true);
    expect((await directoryAs(victimToken)).status).toBe(200);

    expect((await Employee.findById(victim._id).lean()).employmentType).toBe("intern");
  });

  test("a FAILED write evicts nothing", async () => {
    /* Eviction is not free — it throws away every HR user's cached decision —
       so a mutation that did not happen must not cause one. */
    await warmTheCache();
    const before = await actorForVictim();

    const refused = await send("PUT", `/api/employees/${victim._id}`, hrOwnerToken, {
      accessDepartmentId: String(sales._id),
    });
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe("HR_FIELD_NOT_WRITABLE");

    /* THE SAME OBJECT — the entry survived, rather than being cleared and
       rebuilt into an answer that happens to look the same. */
    expect(await actorForVictim()).toBe(before);

    /* Unchanged in the database, and unchanged in the answer. */
    const after = await directoryAs(victimToken);
    expect(after.status).toBe(200);
    expect(String((await Employee.findById(victim._id).lean()).accessDepartmentId))
      .toBe(String(hr._id));
  });

  test("an ordinary edit touches no eligibility field and evicts nothing", async () => {
    await warmTheCache();
    const before = await actorForVictim();

    const write = await send("PUT", `/api/employees/${victim._id}`, hrOwnerToken, {
      middleName: "Q",
    });
    expect(write.status).toBe(200);

    expect(await actorForVictim()).toBe(before);
    expect((await directoryAs(victimToken)).status).toBe(200);
    expect((await Employee.findById(victim._id).lean()).middleName).toBe("Q");
  });

  test("…and the same observable DOES change when the write is a revocation", async () => {
    /* The control. Without this, "the object is the same" could pass because
       the observable is insensitive rather than because the cache survived. */
    await warmTheCache();
    const before = await actorForVictim();

    const write = await send("PUT", `/api/employees/${victim._id}`, hrOwnerToken, {
      status: "inactive",
      isActive: false,
    });
    expect(write.status).toBe(200);

    const after = await actorForVictim();
    expect(after).not.toBe(before);
    expect(after.hasHrApplicationAccess).toBe(false);
  });
});

describe("PATCH /api/employees/bulk-update", () => {
  test("a bulk deactivation revokes on the NEXT request", async () => {
    await warmTheCache();

    const write = await send("PATCH", "/api/employees/bulk-update", hrOwnerToken, {
      employeeIds: [String(victim._id)],
      updates: { status: "inactive", isActive: false },
    });
    expect(write.status).toBe(200);

    const after = await directoryAs(victimToken);
    expect(after.status).toBe(403);
    expect(after.body.code).toBe("HR_NO_APPLICATION_ACCESS");
  });

  test("a bulk edit of an ordinary field leaves the session alone", async () => {
    await warmTheCache();
    const before = await actorForVictim();

    const write = await send("PATCH", "/api/employees/bulk-update", hrOwnerToken, {
      employeeIds: [String(victim._id)],
      updates: { workLocation: "Head Office" },
    });
    expect(write.status).toBe(200);

    expect(await actorForVictim()).toBe(before);
    expect((await directoryAs(victimToken)).status).toBe(200);
  });

  test("a REFUSED bulk write evicts nothing either", async () => {
    await warmTheCache();
    const before = await actorForVictim();

    const refused = await send("PATCH", "/api/employees/bulk-update", hrOwnerToken, {
      employeeIds: [String(victim._id)],
      updates: { accessDepartmentId: String(sales._id) },
    });
    expect(refused.status).toBe(403);
    expect(await actorForVictim()).toBe(before);
  });
});

describe("DELETE /api/employees/:id — the soft delete", () => {
  test("deactivating through the delete route revokes on the NEXT request", async () => {
    await warmTheCache();

    const write = await send("DELETE", `/api/employees/${victim._id}`, hrOwnerToken);
    expect(write.status).toBe(200);

    const after = await directoryAs(victimToken);
    expect(after.status).toBe(403);
    expect(after.body.code).toBe("HR_NO_APPLICATION_ACCESS");

    /* And it really was the soft delete, not a hard one. */
    const row = await Employee.findById(victim._id).lean();
    expect(row.isActive).toBe(false);
    expect(row.status).toBe("inactive");
  });

  test("deleting somebody who does not exist evicts nothing", async () => {
    await warmTheCache();
    const before = await actorForVictim();

    const write = await send("DELETE", "/api/employees/60c0000000000000000000ff", hrOwnerToken);
    expect(write.status).toBe(404);

    expect(await actorForVictim()).toBe(before);
    expect((await directoryAs(victimToken)).status).toBe(200);
  });
});

describe("the person doing the deactivating is unaffected", () => {
  test("the HR owner keeps working across all three routes", async () => {
    expect((await directoryAs(hrOwnerToken)).status).toBe(200);
    await send("DELETE", `/api/employees/${victim._id}`, hrOwnerToken);
    const after = await directoryAs(hrOwnerToken);
    expect(after.status).toBe(200);
    expect(after.body.data.pagination).toBeTruthy();
  });
});

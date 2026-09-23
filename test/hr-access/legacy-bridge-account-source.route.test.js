"use strict";
/**
 * EXPLOIT-FIRST — the bridge consulted a collection the token had never signed
 * in to.
 *
 * `hrContract::seedIdentity` dropped `userType`, which is the one claim that
 * says WHICH account collection authenticated the request. Without it the
 * bridge had to choose the collection from `role`, and the database proof
 * accepted a row matching the id **or the email**. Both halves are too weak:
 *
 *   • a session authenticated against Sales, carrying `role: "hr_manager"`,
 *     was checked against HRDepartment;
 *   • an address that happens to exist in HRDepartment proved somebody else's
 *     account, because an address is not a subject.
 *
 * The bridge now requires the token's account type to BE the collection, and
 * matches the subject by `_id` only. Everything missing, mismatched or
 * unrecognised fails closed.
 *
 * The literals are not invented here: `routes/login.js` sets `userModel` to
 * "hr" when it matched HRDepartment and "ceo" when it matched CEODepartment,
 * and `routes/auth/deptAuth.js` writes `dept.legacyUserType` — the same
 * strings — on both of its paths.
 */

const express = require("express");
const cookieParser = require("cookie-parser");
const mongoose = require("mongoose");

const {
  resetAccessCaches,
  makeDepartment,
  makeEmployee,
  grantHrRole,
  makeLegacyAccount,
  legacyToken,
  cmsToken,
  appToken,
  bearer,
} = require("./helpers");

const hrContract = require("../../Middlewear/hrContract");
const HRDepartment = require("../../models/HRDepartment");
const CEODepartment = require("../../models/CEODepartment");

let server, base, hr, sales, ceo;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/employees", hrContract());
  app.use((req, res) =>
    res.json({ reached: true, template: req.hrAuth?.actor?.template || null }));
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
  ceo = await makeDepartment("ceo", "CEO", "/ceo/dashboard");
  await grantHrRole("configured@grav.in", "viewer", "Someone");
  resetAccessCaches();
});

async function directory(token) {
  const res = await fetch(`${base}/api/employees/all`, { headers: bearer(token) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

describe("the account type must be the collection", () => {
  test("an hr_manager claim on a SALES session is refused, even with a matching HR email", async () => {
    /* The exploit: the address is genuinely in HRDepartment, and the claim says
       hr_manager. The session authenticated against Sales, and that is what
       decides. */
    const row = await makeLegacyAccount("hr", "shared.address@grav.in");
    resetAccessCaches();

    const token = cmsToken({
      id: String(row._id),
      email: "shared.address@grav.in",
      role: "hr_manager",
      userType: "sales",
    });

    const r = await directory(token);
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("HR_NO_APPLICATION_ACCESS");
  });

  test("a ceo claim on any other account type is refused", async () => {
    const row = await makeLegacyAccount("ceo", "chief@grav.in");
    resetAccessCaches();

    for (const userType of ["hr", "sales", "accountant", "store", "qc"]) {
      const token = cmsToken({
        id: String(row._id), email: "chief@grav.in", role: "ceo", userType,
      });
      const r = await directory(token);
      expect({ userType, status: r.status }).toEqual({ userType, status: 403 });
    }

    /* And with the right one, it works. */
    expect((await directory(legacyToken("ceo", row))).status).toBe(200);
  });

  test("an hr claim on a CEO session cannot borrow the CEO collection either", async () => {
    const ceoRow = await makeLegacyAccount("ceo", "crossover@grav.in");
    resetAccessCaches();
    const token = cmsToken({
      id: String(ceoRow._id), email: "crossover@grav.in", role: "hr_manager", userType: "ceo",
    });
    expect((await directory(token)).status).toBe(403);
  });

  test("a missing userType fails closed", async () => {
    const row = await makeLegacyAccount("hr", "notype@grav.in");
    resetAccessCaches();

    for (const claims of [
      { id: String(row._id), email: "notype@grav.in", role: "hr_manager" },
      { id: String(row._id), email: "notype@grav.in", role: "hr_manager", userType: "" },
      { id: String(row._id), email: "notype@grav.in", role: "hr_manager", userType: null },
    ]) {
      const r = await directory(cmsToken(claims));
      expect({ claims, status: r.status }).toEqual({ claims, status: 403 });
    }
  });

  test("an unsupported account type fails closed", async () => {
    const row = await makeLegacyAccount("hr", "weird@grav.in");
    resetAccessCaches();
    for (const userType of ["HR ", "hr_manager", "human-resources", "employee", "admin"]) {
      const token = cmsToken({
        id: String(row._id), email: "weird@grav.in", role: "hr_manager", userType,
      });
      expect({ userType, status: (await directory(token)).status })
        .toEqual({ userType, status: 403 });
    }
  });
});

describe("the subject id is authoritative, not the email", () => {
  test("the right subject with a DIFFERENT email is accepted", async () => {
    /* People change address; the account is still the account. */
    const row = await makeLegacyAccount("hr", "before@grav.in");
    resetAccessCaches();

    const token = cmsToken({
      id: String(row._id),
      email: "somebody.completely.different@grav.in",
      role: "hr_manager",
      userType: "hr",
    });
    const r = await directory(token);
    expect(r.status).toBe(200);
    expect(r.body.template).toBe("hr_viewer");
  });

  test("the right EMAIL with a different subject id is refused", async () => {
    /* This is what the old id-or-email match bought: a token for one account
       proving another account's row because they share an address. */
    await makeLegacyAccount("hr", "shared@grav.in");
    resetAccessCaches();

    const token = cmsToken({
      id: String(new mongoose.Types.ObjectId()),
      email: "shared@grav.in",
      role: "hr_manager",
      userType: "hr",
    });
    const r = await directory(token);
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("HR_NO_APPLICATION_ACCESS");
  });

  test("a subject id that is not an id at all is refused", async () => {
    await makeLegacyAccount("hr", "shape@grav.in");
    resetAccessCaches();
    for (const id of ["", "not-an-object-id", "12345", null]) {
      const token = cmsToken({ id, email: "shape@grav.in", role: "hr_manager", userType: "hr" });
      expect({ id, status: (await directory(token)).status }).toEqual({ id, status: 403 });
    }
  });

  test("a deactivated row is refused for its own correct subject", async () => {
    const row = await makeLegacyAccount("hr", "gone@grav.in");
    resetAccessCaches();
    const token = legacyToken("hr", row);
    expect((await directory(token)).status).toBe(200);

    await HRDepartment.updateOne({ _id: row._id }, { $set: { isActive: false } });
    resetAccessCaches();
    expect((await directory(token)).status).toBe(403);
  });
});

describe("an employee-app identity never enters a CMS bridge", () => {
  test("the app's own token cannot reach HR however it is dressed up", async () => {
    const emp = await makeEmployee({
      biometricId: "GRAPP", email: "app@grav.in", accessDepartmentId: sales._id,
    });
    resetAccessCaches();

    /* The real app token: `type: "employee"`, no role, no userType. */
    expect((await directory(appToken({ id: String(emp._id), email: "app@grav.in" }))).status).toBe(403);
  });

  test("an app token forged with legacy-looking fields still proves nothing", async () => {
    const row = await makeLegacyAccount("hr", "forged@grav.in");
    resetAccessCaches();

    /* Signed with the real secret — the app and the CMS share it — and carrying
       every claim the bridge reads, including the legacy row's own id. `type`
       is what gives it away, and the bridge refuses on that alone. */
    const forged = cmsToken({
      id: String(row._id),
      email: "forged@grav.in",
      type: "employee",
      role: "hr_manager",
      userType: "hr",
      isAdmin: true,
    });
    const r = await directory(forged);
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("HR_NO_APPLICATION_ACCESS");
  });

  test("the CEO bridge refuses an app-typed token too", async () => {
    const row = await makeLegacyAccount("ceo", "appceo@grav.in");
    resetAccessCaches();
    const forged = cmsToken({
      id: String(row._id), email: "appceo@grav.in", type: "employee", role: "ceo", userType: "ceo",
    });
    expect((await directory(forged)).status).toBe(403);
  });
});

describe("the correct, active legacy subjects still work", () => {
  test("HR", async () => {
    const row = await makeLegacyAccount("hr", "realhr@grav.in");
    resetAccessCaches();
    const r = await directory(legacyToken("hr", row));
    expect(r.status).toBe(200);
    expect(r.body.template).toBe("hr_viewer");
  });

  test("CEO", async () => {
    const row = await makeLegacyAccount("ceo", "realceo@grav.in");
    resetAccessCaches();
    const r = await directory(legacyToken("ceo", row));
    expect(r.status).toBe(200);
    expect(r.body.template).toBe("ceo_projection");
  });

  test("a deleted CEO row fails closed for its own subject", async () => {
    const row = await makeLegacyAccount("ceo", "deletedceo@grav.in");
    resetAccessCaches();
    const token = legacyToken("ceo", row);
    expect((await directory(token)).status).toBe(200);

    await CEODepartment.deleteOne({ _id: row._id });
    resetAccessCaches();
    expect((await directory(token)).status).toBe(403);
  });
});



describe("the cache key is an unambiguous encoding, not a delimiter join", () => {
  /* EXPLOIT-FIRST.
   *
   * `join("|")` is injective only if no component can contain a "|". These are
   * claims out of a signed token, so any of them can contain anything, and a
   * "|" moved across a boundary produces two DIFFERENT tuples with ONE key:
   *
   *   role "hr_manager"    + userType "hr"  →  …|hr_manager|hr|…
   *   role "hr_manager|hr" + userType ""    →  …|hr_manager|hr|…
   *
   * They resolve to opposite answers. The first is the legacy HR bridge; the
   * second carries an unrecognised role string and an empty account type, and
   * grants nothing. Under the old key, whichever was resolved first decided
   * what the other one got — so both orders are exercised below.
   */
  const COLLIDING = (row) => ({
    /* The shift is across the id / employeeId boundary, and it moves the "|"
       ITSELF — the only way a fixed-arity join can collide:
       ["OID", "X|Y"] and ["OID|X", "Y"] both serialise to "OID|X|Y".
       Every later component is identical, so the encoding is the only thing
       that can tell these two apart. */
    allowed: {
      id: String(row._id),
      employeeId: "X|Y",
      email: row.email,
      role: "hr_manager",
      userType: "hr",
    },
    refused: {
      /* Not an ObjectId any more, so it names no legacy subject and the bridge
         refuses it — a different ANSWER from the same key. */
      id: `${row._id}|X`,
      employeeId: "Y",
      email: row.email,
      role: "hr_manager",
      userType: "hr",
    },
  });

  test("allowed first, then the colliding refused tuple — still refused", async () => {
    const row = await makeLegacyAccount("hr", "collide.a@grav.in");
    resetAccessCaches();
    const { allowed, refused } = COLLIDING(row);

    expect((await directory(cmsToken(allowed))).status).toBe(200);

    const r = await directory(cmsToken(refused));
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("HR_NO_APPLICATION_ACCESS");

    /* …and the real account is unaffected by the attempt. */
    expect((await directory(cmsToken(allowed))).status).toBe(200);
  });

  test("refused first, then the colliding allowed tuple — still allowed", async () => {
    const row = await makeLegacyAccount("hr", "collide.b@grav.in");
    resetAccessCaches();
    const { allowed, refused } = COLLIDING(row);

    expect((await directory(cmsToken(refused))).status).toBe(403);

    const r = await directory(cmsToken(allowed));
    expect(r.status).toBe(200);
    expect(r.body.template).toBe("hr_viewer");
  });

  test("the resolver keeps them apart directly, in both orders", async () => {
    const { resolveHrActor } = require("../../services/access/hrAuthorization");
    const row = await makeLegacyAccount("hr", "collide.c@grav.in");
    const { allowed, refused } = COLLIDING(row);

    resetAccessCaches();
    expect((await resolveHrActor(allowed)).hasHrApplicationAccess).toBe(true);
    expect((await resolveHrActor(refused)).hasHrApplicationAccess).toBe(false);

    resetAccessCaches();
    expect((await resolveHrActor(refused)).hasHrApplicationAccess).toBe(false);
    expect((await resolveHrActor(allowed)).hasHrApplicationAccess).toBe(true);
  });

  test("a boundary shifted between id and employeeId is two different entries too", async () => {
    /* The same flaw at a different seam, to show the fix is about the encoding
       rather than about one pair of fields. */
    const { resolveHrActor } = require("../../services/access/hrAuthorization");
    resetAccessCaches();

    const left = { id: "a|b", employeeId: "c", email: "x@grav.in", role: "sales" };
    const right = { id: "a", employeeId: "b|c", email: "x@grav.in", role: "sales" };

    const a = await resolveHrActor(left);
    const b = await resolveHrActor(right);
    /* Neither is an HR actor; what matters is that they are resolved
       SEPARATELY rather than one being served the other's cached object. */
    expect(b).not.toBe(a);
  });

  test("invalidateHrActor targets the same entry resolveHrActor stored", async () => {
    const { resolveHrActor, invalidateHrActor } =
      require("../../services/access/hrAuthorization");
    const row = await makeLegacyAccount("hr", "targeted@grav.in");
    resetAccessCaches();

    const claims = {
      id: String(row._id), email: "targeted@grav.in", employeeId: row.employeeId,
      role: "hr_manager", userType: "hr",
    };

    const first = await resolveHrActor(claims);
    expect(await resolveHrActor(claims)).toBe(first);   // cached

    invalidateHrActor(claims);
    const rebuilt = await resolveHrActor(claims);
    expect(rebuilt).not.toBe(first);                    // the right entry went
    expect(rebuilt.hasHrApplicationAccess).toBe(true);
  });
});

describe("the cache key preserves every distinction the answer depends on", () => {
  /* THE COLLISION.
   *
   * `proveActiveLegacyAccount` compares `userType` exactly; the cache key used
   * to lowercase it. The two disagreed, and the disagreement made authorisation
   * depend on REQUEST ORDER: resolve the valid lowercase token first and the
   * malformed uppercase one was answered from its cache entry, never reaching
   * the comparison that should have refused it.
   *
   * Every case below holds id, email, role and employeeId identical and varies
   * only the account type, and each is run in BOTH orders. */
  const MALFORMED = ["HR", "Hr", "hr ", " hr", "hR", "HR "];

  async function tokensFor(kind, row) {
    return {
      valid: legacyToken(kind, row),
      malformed: (userType) =>
        cmsToken({
          id: String(row._id),
          email: row.email,
          employeeId: row.employeeId,
          role: kind === "ceo" ? "ceo" : "hr_manager",
          userType,
        }),
    };
  }

  describe("HR bridge", () => {
    test.each(MALFORMED)("valid first, then %p — the malformed one is still refused", async (bad) => {
      const row = await makeLegacyAccount("hr", "order.a@grav.in");
      resetAccessCaches();
      const t = await tokensFor("hr", row);

      expect((await directory(t.valid)).status).toBe(200);

      const r = await directory(t.malformed(bad));
      expect({ bad, status: r.status, code: r.body.code })
        .toEqual({ bad, status: 403, code: "HR_NO_APPLICATION_ACCESS" });

      /* …and the valid one is still valid afterwards. */
      expect((await directory(t.valid)).status).toBe(200);
    });

    test.each(MALFORMED)("%p first, then the valid one — both answers are right", async (bad) => {
      const row = await makeLegacyAccount("hr", "order.b@grav.in");
      resetAccessCaches();
      const t = await tokensFor("hr", row);

      expect({ bad, status: (await directory(t.malformed(bad))).status })
        .toEqual({ bad, status: 403 });

      /* The refusal must not have poisoned the entry for the real account. */
      expect((await directory(t.valid)).status).toBe(200);
    });
  });

  describe("CEO bridge", () => {
    const CEO_MALFORMED = ["CEO", "Ceo", "ceo ", " ceo"];

    test.each(CEO_MALFORMED)("valid first, then %p — the malformed one is still refused", async (bad) => {
      const row = await makeLegacyAccount("ceo", "order.c@grav.in");
      resetAccessCaches();
      const t = await tokensFor("ceo", row);

      expect((await directory(t.valid)).status).toBe(200);
      expect({ bad, status: (await directory(t.malformed(bad))).status })
        .toEqual({ bad, status: 403 });
      expect((await directory(t.valid)).status).toBe(200);
    });

    test.each(CEO_MALFORMED)("%p first, then the valid one — both answers are right", async (bad) => {
      const row = await makeLegacyAccount("ceo", "order.d@grav.in");
      resetAccessCaches();
      const t = await tokensFor("ceo", row);

      expect({ bad, status: (await directory(t.malformed(bad))).status })
        .toEqual({ bad, status: 403 });
      expect((await directory(t.valid)).status).toBe(200);
    });
  });

  test("the key itself keeps them apart", async () => {
    /* Asserted on the resolver rather than only through HTTP, so a future
       change to the key is caught even if some route happens to mask it. */
    const { resolveHrActor } = require("../../services/access/hrAuthorization");
    const row = await makeLegacyAccount("hr", "keyed@grav.in");
    resetAccessCaches();

    const base = { id: String(row._id), email: "keyed@grav.in", employeeId: row.employeeId, role: "hr_manager" };

    const good = await resolveHrActor({ ...base, userType: "hr" });
    expect(good.hasHrApplicationAccess).toBe(true);

    for (const bad of MALFORMED) {
      const actor = await resolveHrActor({ ...base, userType: bad });
      expect({ bad, access: actor.hasHrApplicationAccess })
        .toEqual({ bad, access: false });
    }

    /* Re-resolving the good one is still the good one. */
    expect((await resolveHrActor({ ...base, userType: "hr" })).hasHrApplicationAccess).toBe(true);
  });

  test("a claim that cannot be stringified does not throw, and grants nothing", async () => {
    const { resolveHrActor } = require("../../services/access/hrAuthorization");
    const row = await makeLegacyAccount("hr", "hostile@grav.in");
    resetAccessCaches();

    const hostile = {
      id: String(row._id),
      email: "hostile@grav.in",
      role: "hr_manager",
      userType: { toString() { throw new Error("boom"); } },
    };
    const actor = await resolveHrActor(hostile);
    expect(actor.hasHrApplicationAccess).toBe(false);

    /* Two unstringifiable claims must not share an entry either. */
    const second = await resolveHrActor({
      ...hostile,
      userType: { toString() { throw new Error("boom"); } },
    });
    expect(second.hasHrApplicationAccess).toBe(false);
  });
});

describe("two tokens differing only in account type do not share a cached answer", () => {
  test("the cache key carries the account source", async () => {
    const row = await makeLegacyAccount("hr", "cache@grav.in");
    resetAccessCaches();

    /* Resolve the GOOD one first, so an entry exists. */
    expect((await directory(legacyToken("hr", row))).status).toBe(200);

    /* Same id, same email, same role — different account type. If the key did
       not carry it, this would be answered from the entry above. */
    const wrong = cmsToken({
      id: String(row._id), email: "cache@grav.in", role: "hr_manager", userType: "sales",
    });
    expect((await directory(wrong)).status).toBe(403);

    /* …and the good one is still good. */
    expect((await directory(legacyToken("hr", row))).status).toBe(200);
  });
});

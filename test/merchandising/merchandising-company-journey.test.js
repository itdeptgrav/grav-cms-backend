// test/merchandising/merchandising-company-journey.test.js
//
// THE ACTING COMPANY, ACROSS THE WHOLE MERCHANDISING JOURNEY.
//
// Not a source assertion — a walk over the real routers, with real records in
// two real companies:
//
//   Overview → My Work → Styles → Style BOM → packaging and development writes
//
// Company selection used to work for the first two and stop at the third. The
// style and BOM endpoints live on the sample-style router and resolved through
// the Sales scope, which never reads an acting company — so a merchandiser who
// chose company A on the Overview silently left that choice behind the moment
// they opened a style, and a two-company user could not open one at all.
//
// What is proved here:
//
//   · a single-company merchandiser never has to choose, anywhere;
//   · a two-company one is ASKED, on every endpoint of the journey;
//   · naming company A shows A's overview, work, styles, BOM — and only A's;
//   · an A work row opens the A BOM, and both writes stay in A;
//   · switching to B returns B's records and none of A's;
//   · a company they do not belong to is refused, non-disclosingly;
//   · a foreign style id and a missing one are the same answer;
//   · no URL edit or omission falls back to another company;
//   · Sales and R&D callers — which send no header — resolve exactly as before.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

jest.mock("../../Middlewear/SalesAuthMiddlewear", () => {
  /* The sample-style router's own gate. Replaced with a pass-through that
     reconstructs `req.user` from a signed token, so this test exercises the
     COMPANY resolution rather than the Sales role allowlist — which is not
     what changed and has its own tests. */
  const jwtLib = require("jsonwebtoken");
  const mw = (req, res, next) => {
    const header = req.headers.authorization || "";
    if (!header.startsWith("Bearer ")) {
      return res.status(401).json({ success: false, message: "Authentication required." });
    }
    try {
      req.user = jwtLib.verify(header.slice(7), process.env.JWT_SECRET || "grav_clothing_secret_key");
      next();
    } catch {
      res.status(401).json({ success: false, message: "Invalid token." });
    }
  };
  mw.withRoles = () => mw;
  mw.RND_ROLES = [];
  return mw;
});

const Employee = require("../../models/Employee");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const DeptUser = require("../../models/Access/DeptUser");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const SalesJourney = require("../../models/CMS_Models/Sales/SalesJourney");
const Enquiry = require("../../models/CMS_Models/Sales/Enquiry");
const Account = require("../../models/CMS_Models/Sales/Account");
const SampleStyle = require("../../models/CMS_Models/Sales/SampleStyle");
const RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");

const salesScope = require("../../services/companyContext/salesScope.service");
const {
  merchandisingScopeFor,
} = require("../../services/companyContext/merchandisingScope.service");

/* ── THE CATALOGUE ARRIVES THROUGH THE BOUNDARY, NOT THROUGH COSTING ───────
   What the company charges for its own development work is Costing's record.
   Merchandising consumes a PROJECTION of it — key, label, description,
   calculation and unit, and never an amount — through
   `services/integration/developmentChargeCatalog.service`.

   This fixture used to build the real Central Costing policy, which meant four
   Merchandising suites imported a costing policy, a calculation engine and a
   Board policy service to test a work queue. That import was the dependency
   this lane exists to remove, and building the far side of a contract is a
   poor way to test the near side of it anyway: it proves Costing works, not
   that Merchandising reads the contract correctly.

   So the seam is stubbed at the boundary. Every assertion below is unchanged;
   what differs is that the catalogue now arrives the way production delivers
   it, and the suite no longer knows Costing exists. */
jest.mock("../../services/integration/developmentChargeCatalog.service", () => {
  const catalogues = new Map();          // companyId -> Map(key -> published row)
  return {
    __publish(companyId, rows) {
      catalogues.set(String(companyId), new Map(rows.map((r) => [r.key, {
        key: r.key,
        label: r.label,
        description: r.description || "",
        /* WHETHER a count is needed, never what it costs. The stub carries the
           published shape exactly — a fixture that leaked an amount would let
           an assertion pass on a field the real projection strips. */
        calculation: r.calculation,
        unit: r.unit || null,
      }])));
    },
    async catalogueFor(companyId) {
      return catalogues.get(String(companyId)) || new Map();
    },
    costingAvailable: () => true,
  };
});

/* A declaration, not a `const`: `describe` bodies run while this module is
   still being evaluated, so a fixture they reach for has to be hoisted. */
async function approveCharges(companyId, charges) {
  /* eslint-disable-next-line global-require */
  require("../../services/integration/developmentChargeCatalog.service")
    .__publish(companyId, charges);
}

let server, base, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  /* Both halves of the journey, mounted exactly as `server.js` mounts them. */
  app.use("/api/cms/merchandising", require("../../routes/CMS_Routes/Merchandising/merchandisingWorkRoute"));
  /* The Merchandising style doors moved off the Sales router into
     routes/CMS_Routes/Merchandising/styleRoute.js. Same handlers, same
     services, same live grant — a file of their own, so this suite no longer
     mounts 4,500 lines of another lane's in-flight rewrite to reach eleven
     endpoints. */
  app.use("/api/cms/merchandising", require("../../routes/CMS_Routes/Merchandising/styleRoute"));

  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

const call = (path, { token, company, method = "GET", body } = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(company ? { "X-Costing-Company": String(company) } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

/** The Merchandising queue, and the style/BOM doors, as one addressable set. */
const M = "/api/cms/merchandising";
const S = "/api/cms/merchandising";

async function actor({ companies = [], grants = {}, isAdmin = false } = {}) {
  const n = ++seq;
  const email = `mj${n}@grav.test`;
  const emp = await Employee.create({
    firstName: "M", lastName: `J${n}`, email, biometricId: `MJ${n}`,
    isActive: true, gender: "Other", department: "Merch",
  });
  await DeptUser.create({
    name: "User", email, passwordHash: "x", isAdmin, isActive: true,
    departmentId: new mongoose.Types.ObjectId(), employeeRef: emp._id,
  });
  for (const co of companies) {
    await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: emp._id, personName: "M" });
  }
  for (const [departmentSlug, role] of Object.entries(grants)) {
    await DepartmentRole.create({
      departmentSlug, email, name: "User", role, isActive: true,
      departmentId: new mongoose.Types.ObjectId(),
    });
  }
  return {
    email,
    employeeId: String(emp._id),
    token: jwt.sign(
      { id: String(emp._id), email, name: "M Actor", role: "sales", employeeId: emp.biometricId, isAdmin },
      process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" },
    ),
  };
}

/**
 * A company with a journey, an enquiry, one style with work open, a packaging
 * item in its own register and a published development charge.
 */
async function world(label) {
  const n = ++seq;
  const co = await Acc_Company.create({
    companyName: `${label} ${n}`, booksFromDate: new Date("2026-04-01"),
  });
  const account = await Account.create({ companyId: co._id, companyName: `Buyer ${n}`, status: "active" });
  const journey = await SalesJourney.create({
    journeyId: `SJ-${label}-${n}`, companyId: co._id, name: `J${n}`,
    accountId: account._id, ownerId: new mongoose.Types.ObjectId(), ownerName: "O",
  });
  const enquiry = await Enquiry.create({
    enquiryId: `ENQ-${label}-${n}`, journeyId: journey._id, accountId: account._id,
    companyId: co._id, title: `Enquiry ${n}`, isActive: true,
    products: [{ product: "Tee", quantity: 500 }],
  });
  const style = await SampleStyle.create({
    sampleStyleId: `SS-${label}-${n}`, styleCode: `SC-${label}-${n}`,
    productName: `${label} tee`, journeyId: journey._id, enquiryId: enquiry._id,
    stage: "materials",
    materials: { status: "pending", rawItems: [] },
  });
  const item = await RawItem.create({
    companyId: co._id, name: `${label} poly bag`, sku: `PB-${label}-${n}`,
    unit: "Piece", category: "Packing", createdBy: new mongoose.Types.ObjectId(),
  });
  await approveCharges(co._id, [{
    key: "pattern-development", label: "Pattern development", active: true,
    calculation: "FLAT_PER_RUN",
    rates: [{ amountMinor: 500000, currency: "INR", effectiveFrom: new Date("2026-01-01") }],
  }]);
  return { co, account, journey, enquiry, style, item, label };
}

/** Somebody who works in both companies and holds a Merchandising seat. */
async function twoCompanyMerchandiser() {
  const A = await world("Alpha");
  const B = await world("Beta");
  const who = await actor({ companies: [A.co, B.co], grants: { merchandiser: "approver" } });
  return { A, B, who };
}

/* ══ ONE COMPANY: NOTHING TO CHOOSE ═══════════════════════════════════════ */

describe("a single-company merchandiser", () => {
  test("walks the whole journey without naming a company anywhere", async () => {
    const A = await world("Solo");
    const who = await actor({ companies: [A.co], grants: { merchandiser: "approver" } });
    const t = { token: who.token };                       // no X-Costing-Company

    const overview = await call(`${M}/overview`, t);
    expect(overview.status).toBe(200);
    expect(overview.body.counts.activeStyles).toBe(1);

    const work = await call(`${M}/work`, t);
    expect(work.body.rows.map((r) => r.productName)).toEqual(["Solo tee"]);

    const styles = await call(`${S}/styles`, t);
    expect(styles.body.styles.map((s) => s.productName)).toEqual(["Solo tee"]);

    const id = work.body.rows[0].styleId;
    expect((await call(`${S}/styles/${id}`, t)).status).toBe(200);
    expect((await call(`${S}/styles/${id}/packaging`, t)).status).toBe(200);
    expect((await call(`${S}/styles/${id}/development`, t)).status).toBe(200);
    expect((await call(`${M}/styles/${id}/packaging-items?q=poly`, t)).status).toBe(200);

    const wrote = await call(`${S}/styles/${id}/packaging-selections`, {
      ...t, method: "POST", body: { rawItemId: String(A.item._id), specification: "Printed poly bag" },
    });
    expect(wrote.status).toBe(201);
  });
});

/* ══ TWO COMPANIES: ASKED, NOT GUESSED ════════════════════════════════════ */

describe("a two-company merchandiser", () => {
  test("is asked on every endpoint of the journey, not just the first two", async () => {
    const { A, who } = await twoCompanyMerchandiser();
    const t = { token: who.token };
    const id = String(A.style._id);

    for (const path of [
      `${M}/overview`,
      `${M}/work`,
      `${S}/styles`,
      `${S}/styles/${id}`,
      `${S}/styles/${id}/packaging`,
      `${S}/styles/${id}/development`,
      `${M}/styles/${id}/packaging-items?q=poly`,
    ]) {
      const res = await call(path, t);
      expect([path, res.status]).toEqual([path, 409]);
      expect(res.body.error.code).toBe("COMPANY_SELECTION_REQUIRED");
      expect(res.body.error.details.companies).toHaveLength(2);
    }

    /* And the writes too — a write that guessed would be worse than a read. */
    const write = await call(`${S}/styles/${id}/packaging-selections`, {
      ...t, method: "POST", body: { rawItemId: String(A.item._id) },
    });
    expect(write.status).toBe(409);
    expect(write.body.error.code).toBe("COMPANY_SELECTION_REQUIRED");
  });

  test("naming company A shows A's overview, work and styles — and only A's", async () => {
    const { A, who } = await twoCompanyMerchandiser();
    const t = { token: who.token, company: A.co._id };

    const overview = await call(`${M}/overview`, t);
    expect(overview.body.counts.activeStyles).toBe(1);

    const work = await call(`${M}/work`, t);
    expect(work.body.rows.map((r) => r.productName)).toEqual(["Alpha tee"]);

    const styles = await call(`${S}/styles`, t);
    expect(styles.body.styles.map((s) => s.productName)).toEqual(["Alpha tee"]);
  });

  test("an A work row opens the A BOM, and every BOM read stays in A", async () => {
    const { A, who } = await twoCompanyMerchandiser();
    const t = { token: who.token, company: A.co._id };

    const work = await call(`${M}/work`, t);
    const id = work.body.rows[0].styleId;
    expect(id).toBe(String(A.style._id));

    const identity = await call(`${S}/styles/${id}`, t);
    expect(identity.status).toBe(200);
    expect(identity.body.style.productName).toBe("Alpha tee");

    expect((await call(`${S}/styles/${id}/packaging`, t)).status).toBe(200);
    const dev = await call(`${S}/styles/${id}/development`, t);
    expect(dev.status).toBe(200);
    expect(dev.body.charges.map((c) => c.key)).toEqual(["pattern-development"]);
  });

  test("every BOM write stays in A, and A's own register is what it may name", async () => {
    const { A, B, who } = await twoCompanyMerchandiser();
    const t = { token: who.token, company: A.co._id };
    const id = String(A.style._id);

    /* The item search is A's master. */
    /* The item search is A's master — through Merchandising's own door now,
       rather than the R&D raw-item search the picker used to borrow. */
    const search = await call(`${M}/styles/${id}/packaging-items?q=poly`, t);
    expect(search.body.items.map((r) => r.name)).toEqual(["Alpha poly bag"]);

    /* B's item is refused on A's style — the same answer a missing one gets. */
    const foreignItem = await call(`${S}/styles/${id}/packaging-selections`, {
      ...t, method: "POST", body: { rawItemId: String(B.item._id), specification: "x" },
    });
    expect(foreignItem.status).toBe(404);
    expect(foreignItem.body.code).toBe("PACKAGING_ITEM_NOT_FOUND");

    /* A's item is accepted, and the selection can then be approved. */
    const added = await call(`${S}/styles/${id}/packaging-selections`, {
      ...t, method: "POST", body: { rawItemId: String(A.item._id), specification: "Printed poly bag" },
    });
    expect(added.status).toBe(201);
    const rowId = added.body.selection.rowId;
    expect(rowId).toBeTruthy();

    const approved = await call(`${S}/styles/${id}/packaging-selections/${rowId}`, {
      ...t, method: "PATCH", body: { status: "approved" },
    });
    expect(approved.status).toBe(200);

    const saved = await call(`${S}/styles/${id}/development`, {
      ...t,
      method: "PUT",
      body: {
        development: [{
          developmentSource: "COMPANY_POLICY", developmentChargeKey: "pattern-development",
          specification: "Pattern set", included: true,
        }],
      },
    });
    expect(saved.status).toBe(200);
    expect(saved.body.development).toHaveLength(1);

    /* And the record that moved is A's, not B's. */
    const bStyle = await SampleStyle.findById(B.style._id).lean();
    expect(bStyle.materials?.packagingSelections || []).toHaveLength(0);
    expect((bStyle.sample?.serviceRequirements || [])).toHaveLength(0);
  });

  test("switching to B returns B's records and none of A's", async () => {
    const { A, B, who } = await twoCompanyMerchandiser();

    const inA = await call(`${S}/styles`, { token: who.token, company: A.co._id });
    expect(inA.body.styles.map((s) => s.productName)).toEqual(["Alpha tee"]);

    const inB = await call(`${S}/styles`, { token: who.token, company: B.co._id });
    expect(inB.body.styles.map((s) => s.productName)).toEqual(["Beta tee"]);
    expect(JSON.stringify(inB.body)).not.toContain("Alpha");

    const workB = await call(`${M}/work`, { token: who.token, company: B.co._id });
    expect(workB.body.rows.map((r) => r.productName)).toEqual(["Beta tee"]);

    /* And A's style is not openable while standing in B. */
    const crossed = await call(`${S}/styles/${A.style._id}`, {
      token: who.token, company: B.co._id,
    });
    expect(crossed.status).toBe(404);
  });
});

/* ══ THE HEADER SELECTS; IT NEVER AUTHORISES ══════════════════════════════ */

describe("a company the actor does not belong to", () => {
  test("is refused on every endpoint, and the refusal names nothing", async () => {
    const { A, who } = await twoCompanyMerchandiser();
    const stranger = await world("Gamma");
    const t = { token: who.token, company: stranger.co._id };
    const id = String(A.style._id);

    for (const path of [
      `${M}/overview`, `${M}/work`,
      `${S}/styles`,
      `${S}/styles/${id}`,
      `${S}/styles/${id}/development`,
    ]) {
      const res = await call(path, t);
      expect([path, res.status]).toEqual([path, 403]);
      expect(res.body.error.code).toBe("TENANT_MEMBERSHIP_UNPROVEN");
      /* Non-disclosing: naming a company they are not in reads exactly like
         naming one that does not exist. */
      expect(JSON.stringify(res.body)).not.toContain(String(stranger.co._id));
      expect(JSON.stringify(res.body)).not.toContain("Gamma");
    }
  });

  test("a write with a foreign header changes nothing", async () => {
    const { A, who } = await twoCompanyMerchandiser();
    const stranger = await world("Delta");
    const res = await call(`${S}/styles/${A.style._id}/packaging-selections`, {
      token: who.token, company: stranger.co._id,
      method: "POST", body: { rawItemId: String(A.item._id), specification: "x" },
    });
    expect(res.status).toBe(403);
    const after = await SampleStyle.findById(A.style._id).lean();
    expect(after.materials?.packagingSelections || []).toHaveLength(0);
  });

  test("a nonsense or blank header cannot fall back to another company", async () => {
    const { A, who } = await twoCompanyMerchandiser();

    /* Garbage: refused, never resolved to "whichever they have". */
    const garbage = await call(`${S}/styles`, {
      token: who.token, company: "not-an-id",
    });
    expect(garbage.status).toBe(403);
    expect(garbage.body.error.code).toBe("TENANT_MEMBERSHIP_UNPROVEN");

    /* Removed entirely: back to being asked, not to a default. */
    const removed = await call(`${S}/styles`, { token: who.token });
    expect(removed.status).toBe(409);
    expect(removed.body.error.code).toBe("COMPANY_SELECTION_REQUIRED");

    /* And A remains reachable only by naming A. */
    const named = await call(`${S}/styles`, { token: who.token, company: A.co._id });
    expect(named.status).toBe(200);
  });

  test("a company in the BODY is not a company", async () => {
    /* The only thing that selects is the header, and only among proven
       memberships. A body field is a claim from a browser. */
    const { A, B, who } = await twoCompanyMerchandiser();
    const res = await call(`${S}/styles/${A.style._id}/packaging-selections`, {
      token: who.token,
      method: "POST",
      body: { rawItemId: String(A.item._id), companyId: String(B.co._id), actingCompanyId: String(B.co._id) },
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("COMPANY_SELECTION_REQUIRED");
  });
});

describe("foreign and missing are one answer", () => {
  test("a style in another company and a style that does not exist read alike", async () => {
    const { A, B, who } = await twoCompanyMerchandiser();
    const inA = { token: who.token, company: A.co._id };
    const gone = new mongoose.Types.ObjectId();

    for (const suffix of ["", "/packaging", "/development"]) {
      const foreign = await call(`${S}/styles/${B.style._id}${suffix}`, inA);
      const missing = await call(`${S}/styles/${gone}${suffix}`, inA);
      expect(foreign.status).toBe(404);
      expect([suffix, missing.status]).toEqual([suffix, 404]);
      expect(foreign.body.message).toBe(missing.body.message);
    }

    /* And a write into a foreign style is the same 404, with nothing written. */
    const write = await call(`${S}/styles/${B.style._id}/packaging-selections`, {
      ...inA, method: "POST", body: { rawItemId: String(A.item._id), specification: "x" },
    });
    expect(write.status).toBe(404);
    const after = await SampleStyle.findById(B.style._id).lean();
    expect(after.materials?.packagingSelections || []).toHaveLength(0);
  });
});

/* ══ SALES AND R&D RESOLVE EXACTLY AS BEFORE ══════════════════════════════ */

describe("the shared scope is unchanged for everybody who does not ask", () => {
  test("with no header, the Merchandising scope IS the Sales scope", async () => {
    /* Not "behaves like": the same object, memoised once for the request. A
       caller that sends nothing therefore cannot be resolved by a second set
       of rules, because there is no second resolution. */
    const A = await world("Shared");
    const who = await actor({ companies: [A.co] });
    const req = { user: { id: who.employeeId, email: who.email }, headers: {}, query: {}, get: () => null };

    const sales = await salesScope.scopeFor(req);
    const merch = await merchandisingScopeFor(req);
    expect(merch).toBe(sales);
    expect(String(merch.companyId)).toBe(String(A.co._id));
  });

  test("an R&D or Sales caller on a shared endpoint is unaffected by the header support", async () => {
    /* `/:id/packaging-selections` and the item search are shared with the R&D
       style page. It sends no acting company, and its answer is the one it
       always had. */
    const A = await world("Rnd");
    const who = await actor({ companies: [A.co], grants: { rnd: "editor" } });
    const t = { token: who.token };
    const id = String(A.style._id);

    const read = await call(`${S}/styles/${id}/packaging-selections`, t);
    expect(read.status).toBe(200);
    expect(read.body).toHaveProperty("packaging");
    expect(read.body).toHaveProperty("readiness");
    expect(read.body).toHaveProperty("shipment");

    /* R&D's raw-item search sat on the Sales style router and was asserted here
       while these endpoints shared that file. It stayed there when the
       Merchandising ones moved out, so the assertion moved with it — to
       `test/sales/sample-style-surface.test.js`, where its subject lives. */
  });

  test("the packaging READ is untouched, including how it fails", async () => {
    /* `GET /:id/packaging-selections` is R&D's, and it was deliberately NOT
       moved onto the Merchandising scope — Merchandising has its own
       `/merchandising/styles/:id/packaging` and never calls this one. So it is
       pinned exactly as it stands, wart and all: a two-company caller still
       gets the opaque 500 it has always given, because the Sales scope's 409
       is flattened by this handler's catch.

       That is a pre-existing shape, not one this pass introduced, and fixing
       it would be changing an R&D route to no Merchandising benefit. Recorded
       here so it cannot be mistaken for something Lane A did. */
    const A = await world("RndA");
    const B = await world("RndB");
    const who = await actor({ companies: [A.co, B.co], grants: { rnd: "editor" } });
    const res = await call(`${S}/styles/${A.style._id}/packaging-selections`, { token: who.token });
    expect(res.status).toBe(500);
  });

  test("the endpoints Merchandising DOES use surface the refusal properly", async () => {
    /* The same underlying refusal, on the routes this pass moved onto the
       Merchandising scope, arrives as the 409 a screen can act on. */
    const A = await world("BothA");
    const B = await world("BothB");
    const who = await actor({ companies: [A.co, B.co], grants: { merchandiser: "approver" } });
    const res = await call(`${S}/styles/${A.style._id}/packaging-selections`, {
      token: who.token, method: "POST", body: { rawItemId: String(A.item._id) },
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("COMPANY_SELECTION_REQUIRED");
  });
});

/* ══ A COMPANY REFUSAL IS NOT EVERY REFUSAL ═══════════════════════════════ */

describe("only the company refusals are re-shaped", () => {
  test("a body carrying money is still refused by name, in its own shape", async () => {
    /* The handlers now let a company-context refusal through with its own
       status and code. That must be the FOUR company codes and nothing else:
       the boundary refusals these same routes raise — a rate in the body, an
       unregistered service, an unconfigured charge — are the same error CLASS,
       and catching the class would have given every one of them the company
       refusal's response shape and broken every screen reading `body.code`.

       This is the regression that caught it. */
    const A = await world("Shape");
    const who = await actor({ companies: [A.co], grants: { merchandiser: "editor" } });

    const res = await call(`${S}/styles/${A.style._id}/development`, {
      token: who.token,
      method: "PUT",
      body: {
        development: [{
          developmentSource: "COMPANY_POLICY", developmentChargeKey: "pattern-development",
          rate: 2000,
        }],
      },
    });

    expect(res.status).toBe(400);
    /* The shape this route has always answered in: a top-level code. */
    expect(res.body.code).toBe("FIELD_NOT_ACCEPTED");
    expect(res.body.message).toMatch(/a rate/);
    expect(res.body.details.field).toBe("rate");
  });

  test("and a company refusal on the same route gets the structured one", async () => {
    const A = await world("ShapeA");
    const B = await world("ShapeB");
    const who = await actor({ companies: [A.co, B.co], grants: { merchandiser: "approver" } });

    const res = await call(`${S}/styles/${A.style._id}/development`, {
      token: who.token, method: "PUT", body: { development: [] },
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("COMPANY_SELECTION_REQUIRED");
  });
});

/* ══ NO JOURNEY, EVEN WITH A COMPANY NAMED ════════════════════════════════ */

describe("the boundary is the same whichever company is named", () => {
  test("no journey, enquiry, customer or commercial value crosses any response", async () => {
    const { A, who } = await twoCompanyMerchandiser();
    const t = { token: who.token, company: A.co._id };
    const id = String(A.style._id);

    const responses = [
      await call(`${M}/overview`, t),
      await call(`${M}/work`, t),
      await call(`${S}/styles`, t),
      await call(`${S}/styles/${id}`, t),
      await call(`${S}/styles/${id}/packaging`, t),
      await call(`${S}/styles/${id}/development`, t),
    ];

    for (const res of responses) {
      expect(res.status).toBe(200);
      const raw = JSON.stringify(res.body);
      for (const banned of [
        /journey/i, /enquiry/i, /accountId/i, /Buyer /, /quotation/i,
        /supplier/i, /margin/i, /amountMinor/i, /\btax\b/i,
      ]) {
        expect(raw).not.toMatch(banned);
      }
    }
  });
});

// test/merchandising/merchandising-authorisation.route.test.js
//
// A SALES SEAT IS NOT A MERCHANDISING SEAT.
//
// The Merchandising style and BOM endpoints live on the sample-style router,
// behind `salesAuth`. That gate proves authority over customers, enquiries and
// quotations — and it was being accepted as authority to approve a packaging
// component and to state what development work a style needs. Anyone the Sales
// allowlist admits could make a Merchandising decision.
//
// Nor is the token's `role` text an answer: it is minted at sign-in and lives
// seven days, so a grant withdrawn five minutes ago still reads the same inside
// it.
//
// What is proved here is the order and the substance of the check on every one
// of those endpoints:
//
//   authenticate → resolve the company → resolve the LIVE Merchandising grant
//   → enforce the level → scope the record → only then read or mutate
//
// and the ladder itself: viewer reads, editor selects and states, approver
// decides. Being named on a record grants nothing.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

jest.mock("../../Middlewear/SalesAuthMiddlewear", () => {
  /* The Sales gate, stubbed to a pass-through. That is the POINT of this file:
     every caller below gets through `salesAuth` exactly as the real allowlist
     would let a Sales user through, and what decides the outcome is the
     Merchandising grant behind it. */
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

const S = "/api/cms/merchandising";
const M = "/api/cms/merchandising";

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

/**
 * A signed-in employee.
 *
 * `tokenRole` is what the JWT SAYS. It is deliberately settable, because the
 * whole point is that it decides nothing — the `grants` are what count, and
 * they live in the database where they can be withdrawn.
 */
async function actor({ companies = [], grants = {}, isAdmin = false, tokenRole = "sales" } = {}) {
  const n = ++seq;
  const email = `ma${n}@grav.test`;
  const emp = await Employee.create({
    firstName: "M", lastName: `A${n}`, email, biometricId: `MA${n}`,
    isActive: true, gender: "Other", department: "Merch",
  });
  await DeptUser.create({
    name: "User", email, passwordHash: "x", isAdmin, isActive: true,
    departmentId: new mongoose.Types.ObjectId(), employeeRef: emp._id,
  });
  for (const co of companies) {
    await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: emp._id, personName: "M" });
  }
  const rows = {};
  for (const [departmentSlug, role] of Object.entries(grants)) {
    rows[departmentSlug] = await DepartmentRole.create({
      departmentSlug, email, name: "User", role, isActive: true,
      departmentId: new mongoose.Types.ObjectId(),
    });
  }
  return {
    email,
    grantRows: rows,
    token: jwt.sign(
      { id: String(emp._id), email, name: "M Actor", role: tokenRole, employeeId: emp.biometricId, isAdmin },
      process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" },
    ),
  };
}

/** One company, one style Merchandising can work on, one packaging item. */
async function world(label = "Auth") {
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
    stage: "materials", materials: { status: "pending", rawItems: [] },
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
  return { co, style, item };
}

/** Add a packaging selection to decide on. The actor needs a real editor grant. */
async function selectionOn(w, who) {
  const res = await call(`${S}/styles/${w.style._id}/packaging-selections`, {
    token: who.token, company: w.co._id,
    method: "POST", body: { rawItemId: String(w.item._id), specification: "Printed poly bag" },
  });
  expect(res.status).toBe(201);
  return res.body.selection.rowId;
}

/* ── The four classes of Merchandising request, addressed once ───────────── */

const READS = (w) => [
  ["style list", `${S}/styles`, "GET", undefined],
  ["style identity", `${S}/styles/${w.style._id}`, "GET", undefined],
  ["packaging handoff", `${S}/styles/${w.style._id}/packaging`, "GET", undefined],
  ["development", `${S}/styles/${w.style._id}/development`, "GET", undefined],
  ["overview", `${M}/overview`, "GET", undefined],
  ["work queue", `${M}/work`, "GET", undefined],
];

const EDITS = (w) => [
  ["save development", `${S}/styles/${w.style._id}/development`, "PUT", {
    development: [{
      developmentSource: "COMPANY_POLICY", developmentChargeKey: "pattern-development",
      specification: "Pattern set", included: true,
    }],
  }],
  ["select packaging", `${S}/styles/${w.style._id}/packaging-selections`, "POST", {
    rawItemId: String(w.item._id), specification: "Printed poly bag",
  }],
];

const DECISIONS = (w, rowId) => [
  ["approve packaging", `${S}/styles/${w.style._id}/packaging-selections/${rowId}`, "PATCH", { status: "approved" }],
  ["withdraw packaging", `${S}/styles/${w.style._id}/packaging-selections/${rowId}`, "PATCH", {
    status: "withdrawn", withdrawnReason: "No longer needed.",
  }],
];

/* ══ NO GRANT, NO MERCHANDISING ═══════════════════════════════════════════ */

describe("an authenticated employee with no Merchandising grant", () => {
  test("reaches nothing, read or write, however good their Sales session", async () => {
    const w = await world();
    const who = await actor({ companies: [w.co] });          // no grants at all
    const t = { token: who.token, company: w.co._id };

    for (const [name, path, method, body] of [...READS(w), ...EDITS(w)]) {
      const res = await call(path, { ...t, method, body });
      expect([name, res.status]).toEqual([name, 403]);
      expect(res.body.error.code).toBe("FORBIDDEN");
      /* The refusal names the department needed and nothing about the record,
         so it cannot double as a way to ask whether a style exists. */
      expect(res.body.error.details.requires.department).toBe("merchandiser");
      expect(JSON.stringify(res.body)).not.toMatch(/tee|SS-|SC-/i);
    }
  });

  test("and nothing is written by the attempt", async () => {
    const w = await world();
    const who = await actor({ companies: [w.co] });
    await call(`${S}/styles/${w.style._id}/packaging-selections`, {
      token: who.token, company: w.co._id,
      method: "POST", body: { rawItemId: String(w.item._id) },
    });
    const after = await SampleStyle.findById(w.style._id).lean();
    expect(after.materials?.packagingSelections || []).toHaveLength(0);
  });
});

describe("a Sales-only user", () => {
  test("cannot reach a Merchandising mutation, whatever the token says", async () => {
    /* Their Sales grant is real and their token says `role: "sales"`. Neither
       is Merchandising authority — the exact hole this chunk closes. */
    const w = await world();
    const who = await actor({ companies: [w.co], grants: { sales: "owner" }, tokenRole: "sales" });

    for (const [name, path, method, body] of EDITS(w)) {
      const res = await call(path, { token: who.token, company: w.co._id, method, body });
      expect([name, res.status]).toEqual([name, 403]);
    }
  });
});

describe("a CEO or Board identity without an explicit Merchandising grant", () => {
  test("is refused like anybody else", async () => {
    /* Seniority is not a department. A CEO who should approve Merchandising
       selections is given a Merchandising grant; until then the answer is no,
       and it is no for reads as well as writes. */
    const w = await world();
    for (const slug of ["ceo", "board"]) {
      const who = await actor({
        companies: [w.co], grants: { [slug]: "owner" }, tokenRole: "ceo",
      });
      const res = await call(`${S}/styles`, { token: who.token, company: w.co._id });
      expect([slug, res.status]).toEqual([slug, 403]);

      const write = await call(`${S}/styles/${w.style._id}/packaging-selections`, {
        token: who.token, company: w.co._id,
        method: "POST", body: { rawItemId: String(w.item._id) },
      });
      expect([slug, write.status]).toEqual([slug, 403]);
    }
  });
});

/* ══ THE LADDER ═══════════════════════════════════════════════════════════ */

describe("viewer", () => {
  test("reads everything Merchandising owns", async () => {
    const w = await world();
    const who = await actor({ companies: [w.co], grants: { merchandiser: "viewer" } });
    for (const [name, path] of READS(w)) {
      const res = await call(path, { token: who.token, company: w.co._id });
      expect([name, res.status]).toEqual([name, 200]);
    }
  });

  test("is refused every mutation class, and changes nothing", async () => {
    const w = await world();
    const owner = await actor({ companies: [w.co], grants: { merchandiser: "owner" } });
    const rowId = await selectionOn(w, owner);
    const viewer = await actor({ companies: [w.co], grants: { merchandiser: "viewer" } });

    for (const [name, path, method, body] of [...EDITS(w), ...DECISIONS(w, rowId)]) {
      const res = await call(path, { token: viewer.token, company: w.co._id, method, body });
      expect([name, res.status]).toEqual([name, 403]);
      expect(res.body.error.details.requires.minimumRole).not.toBe("viewer");
    }

    const after = await SampleStyle.findById(w.style._id).lean();
    /* The owner's one selection, untouched and still proposed. */
    expect(after.materials.packagingSelections).toHaveLength(1);
    expect(after.materials.packagingSelections[0].status).toBe("proposed");
    expect(after.sample?.serviceRequirements || []).toHaveLength(0);
  });
});

describe("editor", () => {
  test("may select a component and state a requirement", async () => {
    const w = await world();
    const who = await actor({ companies: [w.co], grants: { merchandiser: "editor" } });

    const saved = await call(`${S}/styles/${w.style._id}/development`, {
      token: who.token, company: w.co._id, method: "PUT", body: EDITS(w)[0][3],
    });
    expect(saved.status).toBe(200);
    expect(saved.body.development).toHaveLength(1);

    const added = await call(`${S}/styles/${w.style._id}/packaging-selections`, {
      token: who.token, company: w.co._id, method: "POST", body: EDITS(w)[1][3],
    });
    expect(added.status).toBe(201);
  });

  test("may correct a selection's packing instruction — that is an edit", async () => {
    const w = await world();
    const who = await actor({ companies: [w.co], grants: { merchandiser: "editor" } });
    const rowId = await selectionOn(w, who);

    const res = await call(`${S}/styles/${w.style._id}/packaging-selections/${rowId}`, {
      token: who.token, company: w.co._id,
      method: "PATCH", body: { specification: "Printed poly bag, 300x400mm" },
    });
    expect(res.status).toBe(200);
    expect(res.body.selection.specification).toMatch(/300x400/);
  });

  test("may NOT approve or withdraw one — that is a decision", async () => {
    const w = await world();
    const who = await actor({ companies: [w.co], grants: { merchandiser: "editor" } });
    const rowId = await selectionOn(w, who);

    for (const [name, path, method, body] of DECISIONS(w, rowId)) {
      const res = await call(path, { token: who.token, company: w.co._id, method, body });
      expect([name, res.status]).toEqual([name, 403]);
      expect(res.body.error.details.requires.minimumRole).toBe("approver");
    }

    const after = await SampleStyle.findById(w.style._id).lean();
    expect(after.materials.packagingSelections[0].status).toBe("proposed");
  });

  test("cannot smuggle a decision through by attaching an edit to it", async () => {
    /* A body that restates the specification AND approves needs the higher of
       the two levels, or the editor's own door becomes the approver's. */
    const w = await world();
    const who = await actor({ companies: [w.co], grants: { merchandiser: "editor" } });
    const rowId = await selectionOn(w, who);

    const res = await call(`${S}/styles/${w.style._id}/packaging-selections/${rowId}`, {
      token: who.token, company: w.co._id,
      method: "PATCH", body: { specification: "Reworded", status: "approved" },
    });
    expect(res.status).toBe(403);

    const after = await SampleStyle.findById(w.style._id).lean();
    expect(after.materials.packagingSelections[0].status).toBe("proposed");
    expect(after.materials.packagingSelections[0].specification).toBe("Printed poly bag");
  });

  test("being the person who created the row grants nothing extra", async () => {
    /* `selectedBy` names this editor. It is still not authority to approve —
       assignment is a record attribute, never a permission. */
    const w = await world();
    const who = await actor({ companies: [w.co], grants: { merchandiser: "editor" } });
    const rowId = await selectionOn(w, who);

    const stored = await SampleStyle.findById(w.style._id).lean();
    expect(String(stored.materials.packagingSelections[0].selectedBy?.name || "")).toMatch(/Actor|/);

    const res = await call(`${S}/styles/${w.style._id}/packaging-selections/${rowId}`, {
      token: who.token, company: w.co._id, method: "PATCH", body: { status: "approved" },
    });
    expect(res.status).toBe(403);
  });
});

describe("approver", () => {
  test("may take the decision, and may still edit", async () => {
    const w = await world();
    const who = await actor({ companies: [w.co], grants: { merchandiser: "approver" } });
    const rowId = await selectionOn(w, who);

    const approved = await call(`${S}/styles/${w.style._id}/packaging-selections/${rowId}`, {
      token: who.token, company: w.co._id, method: "PATCH", body: { status: "approved" },
    });
    expect(approved.status).toBe(200);
    expect(approved.body.selection.status).toBe("approved");

    const edited = await call(`${S}/styles/${w.style._id}/packaging-selections/${rowId}`, {
      token: who.token, company: w.co._id, method: "PATCH", body: { specification: "Reworded" },
    });
    expect(edited.status).toBe(200);
  });

  test("withdrawing still needs its reason — authority is not a bypass", async () => {
    const w = await world();
    const who = await actor({ companies: [w.co], grants: { merchandiser: "approver" } });
    const rowId = await selectionOn(w, who);

    const res = await call(`${S}/styles/${w.style._id}/packaging-selections/${rowId}`, {
      token: who.token, company: w.co._id, method: "PATCH", body: { status: "withdrawn" },
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("PACKAGING_WITHDRAW_REASON_REQUIRED");
  });
});

describe("a platform administrator", () => {
  /* ── `isAdmin` USED TO BE A RUNG ON THIS LADDER, AND IS NOT ────────────
     It was admitted as `owner` everywhere, on the reasoning that every other
     department shell does the same and that it is how Merchandising opens
     before its first grant. Both true; neither survives a live-grant model.

     `isAdmin` is a token claim AND an account flag, so the one authority that
     could approve a Merchandising selection was the one nobody had granted for
     Merchandising, that no administrator could see in Access Control, and that
     revoking a Merchandising grant could not take away. */
  test("with no Merchandising grant, the JWT claim reaches nothing", async () => {
    const w = await world();
    const admin = await actor({ companies: [w.co], isAdmin: true });
    const t = { token: admin.token, company: w.co._id };

    for (const [name, path, method, body] of [...READS(w), ...EDITS(w)]) {
      const res = await call(path, { ...t, method, body });
      expect([name, res.status]).toEqual([name, 403]);
      expect(res.body.error.code).toBe("FORBIDDEN");
      expect(res.body.error.details.requires.department).toBe("merchandiser");
    }

    const after = await SampleStyle.findById(w.style._id).lean();
    expect(after.materials?.packagingSelections || []).toHaveLength(0);
  });

  test("`req.admin` set by a middleware reaches nothing either", async () => {
    /* The other half of the old bypass read `req.admin`, which an auth
       middleware may set independently of the token. Simulated by mounting a
       router that sets it before the Merchandising one sees the request. */
    const w = await world();
    const admin = await actor({ companies: [w.co] });

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.admin = { id: "platform" }; next(); });
    app.use("/m", require("../../routes/CMS_Routes/Merchandising/merchandisingWorkRoute"));

    const srv = await new Promise((r) => { const x = app.listen(0, () => r(x)); });
    try {
      const res = await fetch(`http://127.0.0.1:${srv.address().port}/m/work`, {
        headers: {
          Authorization: `Bearer ${admin.token}`,
          "X-Costing-Company": String(w.co._id),
        },
      });
      expect(res.status).toBe(403);
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  test("with an explicit grant, they are an ordinary member of that level", async () => {
    /* The remedy is not a bypass: it is a grant, made in Access Control,
       visible to whoever looks, and removable. */
    const w = await world();
    const admin = await actor({
      companies: [w.co], isAdmin: true, grants: { merchandiser: "approver" },
    });
    const rowId = await selectionOn(w, admin);
    const res = await call(`${S}/styles/${w.style._id}/packaging-selections/${rowId}`, {
      token: admin.token, company: w.co._id, method: "PATCH", body: { status: "approved" },
    });
    expect(res.status).toBe(200);
  });

  test("an admin granted only viewer is held to viewer", async () => {
    /* `isAdmin` does not top up the grant it is given. */
    const w = await world();
    const owner = await actor({ companies: [w.co], grants: { merchandiser: "owner" } });
    const rowId = await selectionOn(w, owner);
    const admin = await actor({
      companies: [w.co], isAdmin: true, grants: { merchandiser: "viewer" },
    });

    expect((await call(`${S}/styles`, {
      token: admin.token, company: w.co._id,
    })).status).toBe(200);

    const res = await call(`${S}/styles/${w.style._id}/packaging-selections/${rowId}`, {
      token: admin.token, company: w.co._id, method: "PATCH", body: { status: "approved" },
    });
    expect(res.status).toBe(403);
  });

  test("a forged `isAdmin` claim in an otherwise valid token changes nothing", async () => {
    /* The claim is signed, so it is genuinely theirs — and it is still not a
       Merchandising role, because no route reads it. */
    const w = await world();
    const forged = await actor({ companies: [w.co], isAdmin: true, tokenRole: "ceo" });
    const res = await call(`${S}/styles/${w.style._id}/packaging-selections`, {
      token: forged.token, company: w.co._id,
      method: "POST", body: { rawItemId: String(w.item._id) },
    });
    expect(res.status).toBe(403);
  });
});

/* ══ A GRANT IS LIVE, OR IT IS NOTHING ════════════════════════════════════ */

describe("a withdrawn grant", () => {
  test("fails on the very next request, with the same token", async () => {
    /* Nothing is re-issued and nothing expires. The token is byte-for-byte the
       one that worked a moment ago; what changed is the row in the database,
       and that is the only thing consulted. */
    const w = await world();
    const who = await actor({ companies: [w.co], grants: { merchandiser: "approver" } });
    const t = { token: who.token, company: w.co._id };

    expect((await call(`${S}/styles`, t)).status).toBe(200);

    await DepartmentRole.updateOne({ _id: who.grantRows.merchandiser._id }, { $set: { isActive: false } });

    const read = await call(`${S}/styles`, t);
    expect(read.status).toBe(403);
    const write = await call(`${S}/styles/${w.style._id}/packaging-selections`, {
      ...t, method: "POST", body: { rawItemId: String(w.item._id) },
    });
    expect(write.status).toBe(403);
  });

  test("a deleted grant is the same answer as one that never existed", async () => {
    const w = await world();
    const who = await actor({ companies: [w.co], grants: { merchandiser: "editor" } });
    await DepartmentRole.deleteOne({ _id: who.grantRows.merchandiser._id });
    const res = await call(`${S}/styles/${w.style._id}/development`, {
      token: who.token, company: w.co._id, method: "PUT", body: { development: [] },
    });
    expect(res.status).toBe(403);
  });

  test("a downgrade takes effect immediately", async () => {
    const w = await world();
    const who = await actor({ companies: [w.co], grants: { merchandiser: "approver" } });
    const rowId = await selectionOn(w, who);

    await DepartmentRole.updateOne(
      { _id: who.grantRows.merchandiser._id }, { $set: { role: "viewer" } },
    );

    const res = await call(`${S}/styles/${w.style._id}/packaging-selections/${rowId}`, {
      token: who.token, company: w.co._id, method: "PATCH", body: { status: "approved" },
    });
    expect(res.status).toBe(403);
  });
});

/* ══ A GRANT IS NOT A PASSPORT TO ANOTHER COMPANY ═════════════════════════ */

describe("a valid grant in the wrong company", () => {
  test("a single-membership owner cannot leave their company by asking to", async () => {
    /* The header SELECTS among memberships; it never grants one. An actor who
       holds exactly one membership resolves to it whatever they name, so
       pointing the header at another company changes nothing — and the other
       company's records are then simply not theirs. Missing and foreign are
       one answer, and nothing is written. */
    const mine = await world("Mine");
    const theirs = await world("Theirs");
    const who = await actor({ companies: [mine.co], grants: { merchandiser: "owner" } });

    for (const [name, path, method, body] of [
      ["save development", `${S}/styles/${theirs.style._id}/development`, "PUT",
        { development: [] }],
      ["select packaging", `${S}/styles/${theirs.style._id}/packaging-selections`, "POST",
        { rawItemId: String(theirs.item._id), specification: "x" }],
      ["style identity", `${S}/styles/${theirs.style._id}`, "GET", undefined],
      ["packaging handoff", `${S}/styles/${theirs.style._id}/packaging`, "GET", undefined],
    ]) {
      const res = await call(path, { token: who.token, company: theirs.co._id, method, body });
      expect([name, res.status]).toEqual([name, 404]);
    }

    /* The list is their own company's, not the one they named. */
    const list = await call(`${S}/styles`, {
      token: who.token, company: theirs.co._id,
    });
    expect(list.status).toBe(200);
    expect(list.body.styles.map((x) => x.productName)).toEqual(["Mine tee"]);

    const after = await SampleStyle.findById(theirs.style._id).lean();
    expect(after.materials?.packagingSelections || []).toHaveLength(0);
    expect(after.sample?.serviceRequirements || []).toHaveLength(0);
  });

  test("a multi-membership owner naming a company they are not in is refused outright", async () => {
    /* With a choice to make, the named company is validated — and one they do
       not hold is refused before any record is reached, non-disclosingly. */
    const mine = await world("MultiMine");
    const also = await world("MultiAlso");
    const stranger = await world("Stranger");
    const who = await actor({
      companies: [mine.co, also.co], grants: { merchandiser: "owner" },
    });

    for (const [name, path, method, body] of [...EDITS(stranger), ...READS(stranger)]) {
      const res = await call(path, { token: who.token, company: stranger.co._id, method, body });
      expect([name, res.status]).toEqual([name, 403]);
      expect(res.body.error.code).toBe("TENANT_MEMBERSHIP_UNPROVEN");
      expect(JSON.stringify(res.body)).not.toContain(String(stranger.co._id));
    }

    const after = await SampleStyle.findById(stranger.style._id).lean();
    expect(after.materials?.packagingSelections || []).toHaveLength(0);
  });

  test("a company named in the BODY is not a company", async () => {
    const mine = await world("BodyMine");
    const theirs = await world("BodyTheirs");
    const who = await actor({ companies: [mine.co], grants: { merchandiser: "owner" } });
    /* The body says company B twice over. Nothing reads it: the scope comes
       from the header, validated against memberships, and the style is then
       proved against that. */

    const res = await call(`${S}/styles/${theirs.style._id}/packaging-selections`, {
      token: who.token, company: mine.co._id,
      method: "POST",
      body: {
        rawItemId: String(theirs.item._id),
        companyId: String(theirs.co._id), actingCompanyId: String(theirs.co._id),
      },
    });
    expect(res.status).toBe(404);
    const after = await SampleStyle.findById(theirs.style._id).lean();
    expect(after.materials?.packagingSelections || []).toHaveLength(0);
  });
});

/* ══ ORDER OF OPERATIONS ══════════════════════════════════════════════════ */

describe("the checks run in the order that makes them meaningful", () => {
  test("no grant beats a nonexistent style — the refusal is 403, not 404", async () => {
    /* If the record lookup ran first, a person with no Merchandising role
       could learn which style ids exist by reading the difference between a
       403 and a 404. */
    const w = await world();
    const who = await actor({ companies: [w.co] });
    const gone = new mongoose.Types.ObjectId();

    for (const path of [
      `${S}/styles/${gone}`,
      `${S}/styles/${gone}/packaging`,
      `${S}/styles/${gone}/development`,
    ]) {
      const res = await call(path, { token: who.token, company: w.co._id });
      expect([path, res.status]).toEqual([path, 403]);
    }
  });

  test("an unproven company beats a real grant", async () => {
    const w = await world();
    const other = await world("Other");
    const who = await actor({ companies: [w.co, other.co], grants: { merchandiser: "owner" } });
    /* Two memberships and none named: asked, before the grant is even reached. */
    const res = await call(`${S}/styles`, { token: who.token });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("COMPANY_SELECTION_REQUIRED");
  });

  test("no session at all is 401, everywhere", async () => {
    const w = await world();
    for (const [name, path, method, body] of [...READS(w), ...EDITS(w)]) {
      const res = await call(path, { method, body });
      expect([name, res.status]).toEqual([name, 401]);
    }
  });
});

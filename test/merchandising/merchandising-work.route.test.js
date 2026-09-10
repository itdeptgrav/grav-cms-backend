// test/merchandising/merchandising-work.route.test.js
//
// MERCHANDISING'S OWN READ DOOR, AT THE WIRE.
//
// The claims worth holding are the ones that decide whether this door is
// narrow enough to open:
//
//   · a Merchandising seat opens it and nothing else does — not Sales, not
//     R&D, not Store, not the Project Manager, however senior;
//   · an unproven company reaches no data at all;
//   · another company's styles never appear and never move a count;
//   · counts are per STYLE, and a style with three open things is one style
//     with three actions, listed once;
//   · `q`, `kind`, `limit` and the cursor behave deterministically, and a
//     malformed one is refused rather than silently ignored;
//   · no journey, enquiry, customer, quotation, supplier, rate, cost, margin,
//     tax, consumption, evidence or technical measurement is in any response;
//   · an empty company is a truthful zero, not an error and not a blank.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const Employee = require("../../models/Employee");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const DeptUser = require("../../models/Access/DeptUser");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const SalesJourney = require("../../models/CMS_Models/Sales/SalesJourney");
const Enquiry = require("../../models/CMS_Models/Sales/Enquiry");
const Account = require("../../models/CMS_Models/Sales/Account");
const SampleStyle = require("../../models/CMS_Models/Sales/SampleStyle");

const styleWork = require("../../services/merchandising/styleWork.service");

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

  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/cms/merchandising`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

const call = (path, { token, company } = {}) =>
  fetch(`${base}${path}`, {
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(company ? { "X-Costing-Company": String(company) } : {}),
    },
  }).then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

/** A signed-in person, with whatever memberships and department grants they hold. */
async function actor({ companies = [], grants = {}, isAdmin = false } = {}) {
  const n = ++seq;
  const email = `mw${n}@grav.test`;
  const emp = await Employee.create({
    firstName: "M", lastName: `W${n}`, email, biometricId: `MW${n}`,
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
    token: jwt.sign(
      { id: String(emp._id), email, name: "M Actor", role: "employee", employeeId: emp.biometricId, isAdmin },
      process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" },
    ),
  };
}

/** A company with a journey and an enquiry to hang styles from. */
async function company(name) {
  const n = ++seq;
  const co = await Acc_Company.create({
    companyName: `${name} ${n}`, booksFromDate: new Date("2026-04-01"),
  });
  const account = await Account.create({ companyId: co._id, companyName: `Buyer ${n}`, status: "active" });
  const journey = await SalesJourney.create({
    journeyId: `SJ-${name}-${n}`, companyId: co._id, name: `J${n}`,
    accountId: account._id, ownerId: new mongoose.Types.ObjectId(), ownerName: "O",
  });
  const enquiry = await Enquiry.create({
    enquiryId: `ENQ-${name}-${n}`, journeyId: journey._id, accountId: account._id,
    companyId: co._id, title: `Enquiry ${n}`, isActive: true,
    products: [{ product: "Tee", quantity: 500 }],
  });
  return { co, account, journey, enquiry, n };
}

/**
 * One style of that company. Defaults to a style with NOTHING open: it is at
 * `materials` (Sales has sent it to Merchandising), its materials are selected,
 * there is no packaging proposal, no return and no rejection — so any work a
 * test sees is work that test put there.
 *
 * `stage` is explicit in the default because it is now part of what makes a
 * style Merchandising's at all. A fixture that left it to the schema would sit
 * at `brief`, which is Sales'.
 */
async function style(world, overrides = {}) {
  const n = ++seq;
  return SampleStyle.create({
    sampleStyleId: `SS-${n}`,
    styleCode: `SC-${n}`,
    productName: `Tee ${n}`,
    journeyId: world.journey._id,
    enquiryId: world.enquiry._id,
    stage: "materials",
    materials: { status: "selected", rawItems: [] },
    /* An explicit "no development work needed", with its reason — the truthful
       way to answer the question, and what keeps the default style silent now
       that an EMPTY section counts as unanswered. */
    sample: {
      serviceRequirements: [{
        rowId: `d-${n}`, purpose: "DEVELOPMENT_TOOLING",
        included: false, excludedReason: "This style is unbranded.",
      }],
    },
    ...overrides,
  });
}

/** Two configured development charges — one flat, one per unit. */
const charges = (co) => approveCharges(co._id, [
  {
    key: "pattern-development", label: "Pattern development", active: true,
    calculation: "FLAT_PER_RUN",
    rates: [{ amountMinor: 500000, currency: "INR", effectiveFrom: new Date("2026-01-01") }],
  },
  {
    key: "screen-making", label: "Screen making", active: true,
    calculation: "PER_REQUIREMENT_UNIT", unit: "Screen",
    rates: [{ amountMinor: 200000, currency: "INR", effectiveFrom: new Date("2026-01-01") }],
  },
]);

/** A world plus a merchandiser who can read it. */
async function merchandiser(role = "viewer", { name = "Alpha" } = {}) {
  const world = await company(name);
  const a = await actor({ companies: [world.co], grants: { merchandiser: role } });
  return { ...world, a };
}

const overview = (w, a = w.a) => call("/overview", { token: a.token, company: w.co._id });
const work = (w, qs = "", a = w.a) => call(`/work${qs}`, { token: a.token, company: w.co._id });

/* ══ THE DOOR ═════════════════════════════════════════════════════════════ */

describe("who may open it", () => {
  test("an unauthenticated request is refused, on both endpoints", async () => {
    for (const path of ["/overview", "/work"]) {
      const res = await call(path);
      expect(res.status).toBe(401);
    }
  });

  test("a Sales, R&D, Store or Project Manager seat reaches nothing", async () => {
    const w = await company("Beta");
    for (const slug of ["sales", "rnd", "store", "project-manager"]) {
      const a = await actor({ companies: [w.co], grants: { [slug]: "owner" } });
      for (const path of ["/overview", "/work"]) {
        const res = await call(path, { token: a.token, company: w.co._id });
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe("FORBIDDEN");
        /* The refusal names the department needed, never the data behind it. */
        expect(JSON.stringify(res.body)).not.toMatch(/style|journey|customer/i);
      }
    }
  });

  test("every Merchandising level may read", async () => {
    for (const role of ["viewer", "editor", "approver", "owner"]) {
      const w = await merchandiser(role);
      expect((await overview(w)).status).toBe(200);
      expect((await work(w)).status).toBe(200);
    }
  });

  test("a platform administrator with no grant reaches nothing", async () => {
    /* `isAdmin` used to be admitted as `owner` here. It is not a rung on this
       ladder any more: it is a token claim and an account flag, so it was the
       one authority nobody had granted for Merchandising, that no
       administrator could see in Access Control, and that revoking a
       Merchandising grant could not take away. */
    const w = await company("Gamma");
    const admin = await actor({ companies: [w.co], isAdmin: true });
    expect((await overview(w, admin)).status).toBe(403);
    expect((await work(w, "", admin)).status).toBe(403);
  });

  test("and with an explicit grant is an ordinary member of that level", async () => {
    const w = await company("GammaGranted");
    const admin = await actor({
      companies: [w.co], isAdmin: true, grants: { merchandiser: "viewer" },
    });
    expect((await overview(w, admin)).status).toBe(200);
    expect((await work(w, "", admin)).status).toBe(200);
  });

  test("a Merchandising seat with no proven company is refused", async () => {
    /* Two companies exist and this person is a member of neither, so the
       single-company deployment allowance cannot apply. */
    await company("Delta");
    const other = await company("Epsilon");
    const a = await actor({ grants: { merchandiser: "owner" } });
    const res = await call("/overview", { token: a.token, company: other.co._id });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("TENANT_MEMBERSHIP_UNPROVEN");
  });
});

/* ══ WHICH COMPANY AM I WORKING IN ════════════════════════════════════════ */

describe("acting company", () => {
  /** Two companies, one person who belongs to both, one style in each. */
  async function bothCompanies() {
    const one = await company("Uno");
    const two = await company("Dos");
    const a = await actor({
      companies: [one.co, two.co], grants: { merchandiser: "editor" },
    });
    await style({ ...one, a }, { productName: "Uno tee", materials: { status: "pending", rawItems: [] } });
    await style({ ...two, a }, { productName: "Dos tee", materials: { status: "pending", rawItems: [] } });
    return { one, two, a };
  }

  test("a single-company merchandiser needs no company header at all", async () => {
    const w = await merchandiser("editor");
    await style(w, { materials: { status: "pending", rawItems: [] } });

    for (const path of ["/overview", "/work"]) {
      const res = await call(path, { token: w.a.token });   // no X-Costing-Company
      expect(res.status).toBe(200);
    }
    expect((await call("/overview", { token: w.a.token })).body.counts.MATERIALS_UNANSWERED).toBe(1);
  });

  test("a two-company merchandiser is ASKED, not guessed at, on both endpoints", async () => {
    const { a } = await bothCompanies();
    for (const path of ["/overview", "/work"]) {
      const res = await call(path, { token: a.token });     // no company named
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("COMPANY_SELECTION_REQUIRED");
      /* The refusal carries the authorised ids, so a chooser has something to
         offer without a second endpoint. */
      expect(res.body.error.details.companies).toHaveLength(2);
      /* And it is not a data response wearing an error's clothes. */
      expect(res.body.rows).toBeUndefined();
      expect(res.body.counts).toBeUndefined();
    }
  });

  test("naming an authorised company scopes both endpoints to exactly it", async () => {
    const { one, two, a } = await bothCompanies();

    const first = await call("/work", { token: a.token, company: one.co._id });
    expect(first.status).toBe(200);
    expect(first.body.rows.map((r) => r.productName)).toEqual(["Uno tee"]);

    /* Switching is the same request with a different company. Nothing from the
       first answer survives into the second. */
    const second = await call("/work", { token: a.token, company: two.co._id });
    expect(second.body.rows.map((r) => r.productName)).toEqual(["Dos tee"]);

    const counts = await call("/overview", { token: a.token, company: two.co._id });
    expect(counts.body.counts.activeStyles).toBe(1);
  });

  test("naming a company they do not belong to is refused, and says nothing about it", async () => {
    const { a } = await bothCompanies();
    const stranger = await company("Tres");

    const res = await call("/overview", { token: a.token, company: stranger.co._id });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("TENANT_MEMBERSHIP_UNPROVEN");
    /* Non-disclosing: naming a company they are not in reads the same as
       naming one that does not exist. */
    expect(JSON.stringify(res.body)).not.toContain(String(stranger.co._id));
  });

  test("a platform administrator follows the same rule when the context is ambiguous", async () => {
    /* Admin is a property of the PERSON, and it decides what they may do —
       never which company's books they are standing in. An admin holding two
       memberships is asked exactly like anybody else. */
    const one = await company("AdminOne");
    const two = await company("AdminTwo");
    /* Granted, because since M0.2 an administrator needs a Merchandising role
       like anybody else — the point of this test is the COMPANY rule, and it
       is unchanged. */
    const admin = await actor({
      companies: [one.co, two.co], isAdmin: true, grants: { merchandiser: "owner" },
    });

    const asked = await call("/overview", { token: admin.token });
    expect(asked.status).toBe(409);
    expect(asked.body.error.code).toBe("COMPANY_SELECTION_REQUIRED");

    const named = await call("/overview", { token: admin.token, company: one.co._id });
    expect(named.status).toBe(200);
  });
});

/* ══ THE COUNTS ═══════════════════════════════════════════════════════════ */

describe("the overview counts", () => {
  test("an empty company is a truthful set of zeroes, not an error", async () => {
    const w = await merchandiser();
    const res = await overview(w);
    expect(res.status).toBe(200);
    expect(res.body.counts.activeStyles).toBe(0);
    expect(res.body.counts.stylesWithAction).toBe(0);
    for (const kind of styleWork.WORK_KINDS) expect(res.body.counts[kind]).toBe(0);
    expect(res.body.generatedAt).toBeTruthy();

    const list = await work(w);
    expect(list.body.rows).toEqual([]);
    expect(list.body.hasMore).toBe(false);
    expect(list.body.nextCursor).toBe(null);
  });

  test("a company with no Sales parent at all is zero, not an error", async () => {
    const co = await Acc_Company.create({
      companyName: `Lonely ${++seq}`, booksFromDate: new Date("2026-04-01"),
    });
    const a = await actor({ companies: [{ _id: co._id }], grants: { merchandiser: "viewer" } });
    const res = await call("/overview", { token: a.token, company: co._id });
    expect(res.status).toBe(200);
    expect(res.body.counts.activeStyles).toBe(0);
  });

  test("each count matches its real stored state, per style", async () => {
    const w = await merchandiser();
    await charges(w.co);

    await style(w);                                                    // nothing open
    await style(w, { materials: { status: "pending", rawItems: [] } });
    await style(w, {
      materials: {
        status: "selected",
        packagingSelections: [
          { rowId: "a", rawItemId: new mongoose.Types.ObjectId(), status: "proposed" },
          { rowId: "b", rawItemId: new mongoose.Types.ObjectId(), status: "proposed" },
          { rowId: "c", rawItemId: new mongoose.Types.ObjectId(), status: "approved" },
        ],
      },
    });
    await style(w, {
      sample: {
        serviceRequirements: [
          /* Charged per screen, and nobody said how many. */
          {
            rowId: "d1", purpose: "DEVELOPMENT_TOOLING", developmentSource: "COMPANY_POLICY",
            developmentChargeKey: "screen-making", included: true,
          },
        ],
      },
    });
    await style(w, { bomApproval: { status: "rejected", note: "Trim missing." } });

    const { body } = await overview(w);
    expect(body.counts.activeStyles).toBe(5);
    /* Three proposed packaging rows on ONE style is ONE affected style. */
    expect(body.counts.PACKAGING_APPROVAL_REQUIRED).toBe(1);
    expect(body.counts.MATERIALS_UNANSWERED).toBe(1);
    expect(body.counts.DEVELOPMENT_INCOMPLETE).toBe(1);
    expect(body.counts.BOM_APPROVAL_REJECTED).toBe(1);
    expect(body.counts.stylesWithAction).toBe(4);
  });

  test("a materials submission already with Sales is not the merchandiser's work", async () => {
    const w = await merchandiser();
    await style(w, {
      materials: { status: "pending", rawItems: [] },
      materialsChangeLog: [{ items: ["Cotton"], status: "pending" }],
    });
    const { body } = await overview(w);
    expect(body.counts.MATERIALS_UNANSWERED).toBe(0);
    expect(body.counts.stylesWithAction).toBe(0);
  });

  test("an inactive style is not active work", async () => {
    const w = await merchandiser();
    await style(w, { isActive: false, materials: { status: "pending", rawItems: [] } });
    const { body } = await overview(w);
    expect(body.counts.activeStyles).toBe(0);
    expect(body.counts.MATERIALS_UNANSWERED).toBe(0);
  });

  test("a development requirement that is complete is not a gap", async () => {
    const w = await merchandiser();
    await charges(w.co);
    await style(w, {
      sample: {
        serviceRequirements: [{
          rowId: "ok", purpose: "DEVELOPMENT_TOOLING", developmentSource: "COMPANY_POLICY",
          developmentChargeKey: "pattern-development", included: true,
        }],
      },
    });
    const { body } = await overview(w);
    expect(body.counts.DEVELOPMENT_INCOMPLETE).toBe(0);
  });

  test("Production's outside processes do not answer Merchandising's development question", async () => {
    /* The two share `sample.serviceRequirements`, and an OUTSIDE_PROCESS row
       is Production's. It is not a gap — and it is not an ANSWER either: the
       Development section is still empty, which reads as "nobody has looked". */
    const w = await merchandiser();
    await charges(w.co);
    await style(w, {
      sample: {
        serviceRequirements: [{
          rowId: "p1", purpose: "OUTSIDE_PROCESS",
          serviceId: new mongoose.Types.ObjectId(), included: true,
        }],
      },
    });
    const { body } = await overview(w);
    expect(body.counts.DEVELOPMENT_INCOMPLETE).toBe(1);

    const list = await work(w, "?kind=DEVELOPMENT_INCOMPLETE");
    expect(list.body.rows).toHaveLength(1);
    expect(list.body.rows[0].actions[0].label).toMatch(/Nobody has said/);
  });
});

/* ══ WHOSE DESK IS THE STYLE ON ═══════════════════════════════════════════ */

describe("the Sales → Merchandising handoff is respected", () => {
  /** Materials unanswered, at whichever stage the test is about. */
  const pendingAt = (w, stage) => style(w, {
    productName: `At ${stage}`, stage, materials: { status: "pending", rawItems: [] },
  });

  test("pending materials at `brief` are Sales' — not counted, not listed", async () => {
    /* `brief` means "carried from the enquiry and sent nowhere yet". Sending a
       style BACK to brief even resets `materials.status` to pending, so a
       pending pick there is a state Sales put it in. */
    const w = await merchandiser();
    await pendingAt(w, "brief");

    const { body } = await overview(w);
    expect(body.counts.MATERIALS_UNANSWERED).toBe(0);
    expect(body.counts.stylesWithAction).toBe(0);
    expect((await work(w)).body.rows).toEqual([]);
    /* Still part of the portfolio — it is this company's style, it is simply
       not this company's merchandiser's work yet. */
    expect(body.counts.activeStyles).toBe(1);
  });

  test("pending materials at `materials` are Merchandising's", async () => {
    const w = await merchandiser();
    await pendingAt(w, "materials");

    const { body } = await overview(w);
    expect(body.counts.MATERIALS_UNANSWERED).toBe(1);

    const list = await work(w, "?kind=MATERIALS_UNANSWERED");
    expect(list.body.rows).toHaveLength(1);
    expect(list.body.rows[0].actions.map((a) => a.kind)).toEqual(["MATERIALS_UNANSWERED"]);
  });

  test("pending materials at `rnd` are R&D's — the style went on behind an approved BOM", async () => {
    const w = await merchandiser();
    await pendingAt(w, "rnd");
    expect((await overview(w)).body.counts.MATERIALS_UNANSWERED).toBe(0);
  });

  test("a style with no stage at all is treated as `brief`, never as work", async () => {
    /* The field defaults to `brief`, so a document without one predates it and
       the schema's own answer is `brief`. Guessing `materials` would invent
       work on a record nobody routed. */
    const w = await merchandiser();
    await SampleStyle.collection.insertOne({
      sampleStyleId: `SS-NOSTAGE-${++seq}`, productName: "Stageless",
      journeyId: w.journey._id, isActive: true,
      materials: { status: "pending" },
      createdAt: new Date(), updatedAt: new Date(),
    });
    const { body } = await overview(w);
    expect(body.counts.activeStyles).toBe(1);
    expect(body.counts.MATERIALS_UNANSWERED).toBe(0);
  });

  test("a submission already with Sales is not the merchandiser's work, even at `materials`", async () => {
    const w = await merchandiser();
    await style(w, {
      stage: "materials",
      materials: { status: "pending", rawItems: [] },
      materialsChangeLog: [{ items: ["Cotton"], status: "pending" }],
    });
    expect((await overview(w)).body.counts.MATERIALS_UNANSWERED).toBe(0);
  });

  test("the count, the filtered list and the row's actions agree at every stage", async () => {
    /* The predicate selects and the derivation labels. If they disagree, a
       style is either listed with no reason to be there or counted and then
       missing from its own queue. */
    const w = await merchandiser();
    for (const stage of ["brief", "materials", "rnd"]) await pendingAt(w, stage);

    const counted = (await overview(w)).body.counts.MATERIALS_UNANSWERED;
    const listed = (await work(w, "?kind=MATERIALS_UNANSWERED&limit=100")).body.rows;
    expect(listed).toHaveLength(counted);
    for (const row of listed) {
      expect(row.actions.map((a) => a.kind)).toContain("MATERIALS_UNANSWERED");
    }
    /* And in an unfiltered list, only the style that is genuinely with
       Merchandising states the action. */
    const all = (await work(w, "?limit=100")).body.rows;
    const withMaterials = all.filter((r) => r.actions.some((a) => a.kind === "MATERIALS_UNANSWERED"));
    expect(withMaterials).toHaveLength(1);
    expect(withMaterials[0].productName).toBe("At materials");
  });

  test("work handed over explicitly is not gated on stage", async () => {
    /* A returned material, a rejected BOM and a proposed packaging selection
       each carry their own evidence that somebody put this in front of
       Merchandising. Filtering those by routing position would hide work that
       was deliberately handed over. */
    const w = await merchandiser();
    await style(w, {
      productName: "Rejected at brief", stage: "brief",
      bomApproval: { status: "rejected", note: "Trim missing." },
    });
    await style(w, {
      productName: "Proposed at rnd", stage: "rnd",
      materials: {
        status: "selected",
        packagingSelections: [{ rowId: "a", rawItemId: new mongoose.Types.ObjectId(), status: "proposed" }],
      },
    });

    const { body } = await overview(w);
    expect(body.counts.BOM_APPROVAL_REJECTED).toBe(1);
    expect(body.counts.PACKAGING_APPROVAL_REQUIRED).toBe(1);
    expect(body.counts.stylesWithAction).toBe(2);
  });
});

/* ══ DEVELOPMENT: SILENCE IS NOT AN ANSWER ════════════════════════════════ */

describe("an empty Development section is unanswered", () => {
  const withRequirements = (w, rows, extra = {}) => style(w, {
    sample: { serviceRequirements: rows }, ...extra,
  });

  test("no Development row at all, on a style Merchandising has, is unanswered", async () => {
    const w = await merchandiser();
    await charges(w.co);
    await withRequirements(w, []);

    const { body } = await overview(w);
    expect(body.counts.DEVELOPMENT_INCOMPLETE).toBe(1);
    const list = await work(w, "?kind=DEVELOPMENT_INCOMPLETE");
    expect(list.body.rows[0].actions[0].label)
      .toBe("Nobody has said whether this style needs development or tooling work");
  });

  test("an empty section at `brief` is nobody's work yet", async () => {
    const w = await merchandiser();
    await charges(w.co);
    await withRequirements(w, [], { stage: "brief" });
    expect((await overview(w)).body.counts.DEVELOPMENT_INCOMPLETE).toBe(0);
  });

  test("an empty section at `rnd` is still Merchandising's unanswered question", async () => {
    /* The style passed through Merchandising and the answer was never
       recorded. The costing input map reads it the same way, as a
       Merchandising requirement with no stage condition. */
    const w = await merchandiser();
    await charges(w.co);
    await withRequirements(w, [], { stage: "rnd" });
    expect((await overview(w)).body.counts.DEVELOPMENT_INCOMPLETE).toBe(1);
  });

  test("a complete included requirement is an answer", async () => {
    const w = await merchandiser();
    await charges(w.co);
    await withRequirements(w, [{
      rowId: "d1", purpose: "DEVELOPMENT_TOOLING", included: true,
      developmentSource: "COMPANY_POLICY", developmentChargeKey: "pattern-development",
    }]);
    expect((await overview(w)).body.counts.DEVELOPMENT_INCOMPLETE).toBe(0);
  });

  test("an explicit not-applicable WITH its reason is an answer", async () => {
    const w = await merchandiser();
    await charges(w.co);
    await withRequirements(w, [{
      rowId: "d1", purpose: "DEVELOPMENT_TOOLING",
      included: false, excludedReason: "This style is unbranded.",
    }]);
    expect((await overview(w)).body.counts.DEVELOPMENT_INCOMPLETE).toBe(0);
  });

  test("a not-applicable row WITHOUT a reason is incomplete, not an answer", async () => {
    const w = await merchandiser();
    await charges(w.co);
    await withRequirements(w, [{
      rowId: "d1", purpose: "DEVELOPMENT_TOOLING", included: false,
    }]);
    const { body } = await overview(w);
    expect(body.counts.DEVELOPMENT_INCOMPLETE).toBe(1);
    const list = await work(w, "?kind=DEVELOPMENT_INCOMPLETE");
    /* Incomplete, not unanswered — a row exists, it just does not say enough. */
    expect(list.body.rows[0].actions[0].label).toMatch(/1 development requirement is incomplete/);
  });
});

/* ══ TENANCY ══════════════════════════════════════════════════════════════ */

describe("another company's work is not this company's", () => {
  test("cross-company styles never appear and never move a count", async () => {
    const mine = await merchandiser();
    const theirs = await company("Zeta");
    await style(mine, { materials: { status: "pending", rawItems: [] } });
    for (let i = 0; i < 3; i += 1) {
      await style(theirs, { materials: { status: "pending", rawItems: [] } });
    }

    const { body } = await overview(mine);
    expect(body.counts.activeStyles).toBe(1);
    expect(body.counts.MATERIALS_UNANSWERED).toBe(1);

    const list = await work(mine);
    expect(list.body.rows).toHaveLength(1);
    expect(list.body.rows[0].productName).toMatch(/Tee/);
  });

  test("a foreign journey is not rescued by an owned enquiry", async () => {
    /* The pathological shape: the style's authoritative parent belongs to
       somebody else, and its enquiry is ours. `ownershipProofFor` refuses it,
       and so must the bound — reading ownership off a second parent after the
       first said "not yours" is a leak, not a fallback. */
    const mine = await merchandiser();
    const theirs = await company("Eta");
    await SampleStyle.create({
      sampleStyleId: `SS-X-${++seq}`, productName: "Smuggled tee",
      journeyId: theirs.journey._id, enquiryId: mine.enquiry._id,
      materials: { status: "pending", rawItems: [] },
    });

    const { body } = await overview(mine);
    expect(body.counts.activeStyles).toBe(0);
    const list = await work(mine);
    expect(list.body.rows).toEqual([]);
  });

  test("a journey that names no company proves nothing, and its style is excluded", async () => {
    /* A pre-tenancy journey. It cannot be attributed with company-bounded
       reads — establishing it would mean enumerating every unstamped journey
       in the database — so it fails closed. `backfill-journey-company.js`
       exists to settle these; guessing here would be the same thing that
       backfill refuses to do. */
    const w = await merchandiser();
    const unstamped = await SalesJourney.create({
      journeyId: `SJ-NOCO-${++seq}`, name: "Unstamped", companyId: null,
      accountId: w.account._id, ownerId: new mongoose.Types.ObjectId(), ownerName: "O",
    });
    await SampleStyle.create({
      sampleStyleId: `SS-NOCO-${++seq}`, productName: "Orphan tee",
      journeyId: unstamped._id, enquiryId: w.enquiry._id, stage: "materials",
      materials: { status: "pending", rawItems: [] },
    });

    const { body } = await overview(w);
    expect(body.counts.activeStyles).toBe(0);
    expect((await work(w)).body.rows).toEqual([]);
  });

  test("a dangling journey reference is excluded, not rescued by an enquiry", async () => {
    const w = await merchandiser();
    await SampleStyle.create({
      sampleStyleId: `SS-DANGLE-${++seq}`, productName: "Dangling tee",
      journeyId: new mongoose.Types.ObjectId(),   // no such journey
      enquiryId: w.enquiry._id, stage: "materials",
      materials: { status: "pending", rawItems: [] },
    });
    expect((await overview(w)).body.counts.activeStyles).toBe(0);
  });

  test("a house sample with no journey is reached through its enquiry", async () => {
    const w = await merchandiser();
    await SampleStyle.create({
      sampleStyleId: `SS-H-${++seq}`, productName: "House tee",
      sampleType: "house", enquiryId: w.enquiry._id,
      stage: "materials",
      materials: { status: "pending", rawItems: [] },
    });
    const { body } = await overview(w);
    expect(body.counts.activeStyles).toBe(1);
    expect(body.counts.MATERIALS_UNANSWERED).toBe(1);
  });
});

/* ══ THE QUEUE ════════════════════════════════════════════════════════════ */

describe("the work queue", () => {
  test("a style with several open things appears once, with all of them", async () => {
    const w = await merchandiser();
    await charges(w.co);
    await style(w, {
      productName: "Busy tee",
      materials: {
        status: "pending",
        packagingSelections: [{ rowId: "a", rawItemId: new mongoose.Types.ObjectId(), status: "proposed" }],
      },
      bomApproval: { status: "rejected", note: "Trim missing." },
    });

    const { body } = await work(w);
    expect(body.rows).toHaveLength(1);
    const kinds = body.rows[0].actions.map((a) => a.kind);
    expect(kinds).toEqual([
      "MATERIALS_UNANSWERED",
      "PACKAGING_APPROVAL_REQUIRED",
      "BOM_APPROVAL_REJECTED",
    ]);
  });

  test("a correction reason is published only where it was recorded for Merchandising", async () => {
    const w = await merchandiser();
    await style(w, {
      /* R&D's whole technical record sits on this style, returned material
         and all. None of it is read any more — not the measurement, and not
         the return either (see the returned-material suite below). */
      techSheet: {
        technical: {
          materials: [{
            rawItemId: new mongoose.Types.ObjectId(), rawItemName: "Shell fabric",
            consumptionPerPiece: 0.42, unit: "kg", evidenceNote: "measured on proto",
            returnedToMaterials: { reason: "Wrong GSM.", at: new Date() },
          }],
        },
      },
      bomApproval: { status: "rejected", note: "Trim missing." },
    });

    const { body } = await work(w);
    const byKind = Object.fromEntries(body.rows[0].actions.map((a) => [a.kind, a]));
    /* The one reason that has a clearing rule: a rejection is cleared by the
       next approval request, which sets the status to `pending`. */
    expect(byKind.BOM_APPROVAL_REJECTED.reason).toBe("Trim missing.");
    const raw = JSON.stringify(body);
    expect(raw).not.toMatch(/0\.42/);
    expect(raw).not.toMatch(/consumption/i);
    expect(raw).not.toMatch(/measured on proto/);
    expect(raw).not.toMatch(/Wrong GSM/);
  });

  test("`kind` narrows both the rows and the actions each row states", async () => {
    const w = await merchandiser();
    await style(w, {
      productName: "Both", materials: { status: "pending", rawItems: [] },
      bomApproval: { status: "rejected", note: "Trim missing." },
    });
    await style(w, { productName: "Rejected only", bomApproval: { status: "rejected", note: "No." } });

    const all = await work(w);
    expect(all.body.rows).toHaveLength(2);

    const filtered = await work(w, "?kind=MATERIALS_UNANSWERED");
    expect(filtered.body.rows).toHaveLength(1);
    expect(filtered.body.rows[0].productName).toBe("Both");
    expect(filtered.body.rows[0].actions.map((a) => a.kind)).toEqual(["MATERIALS_UNANSWERED"]);
  });

  test("`q` searches product name, style code and reference — server-side", async () => {
    const w = await merchandiser();
    const target = await style(w, {
      productName: "Oxford shirt", styleCode: "SC-OXF", sampleStyleId: `SS-OXF-${++seq}`,
      materials: { status: "pending", rawItems: [] },
    });
    await style(w, { productName: "Crew tee", materials: { status: "pending", rawItems: [] } });

    for (const term of ["oxford", "SC-OXF", target.sampleStyleId]) {
      const res = await work(w, `?q=${encodeURIComponent(term)}`);
      expect(res.body.rows.map((r) => r.styleId)).toEqual([String(target._id)]);
    }
  });

  test("a search expression is escaped, not executed", async () => {
    const w = await merchandiser();
    await style(w, { productName: "Crew tee", materials: { status: "pending", rawItems: [] } });
    const res = await work(w, "?q=%2E%2A");   // ".*"
    expect(res.status).toBe(200);
    expect(res.body.rows).toEqual([]);
  });

  test("the cursor pages deterministically, with no row skipped or repeated", async () => {
    const w = await merchandiser();
    for (let i = 0; i < 5; i += 1) {
      await style(w, { productName: `Paged ${i}`, materials: { status: "pending", rawItems: [] } });
    }

    const seen = [];
    let cursor = null;
    let pages = 0;
    do {
      const res = await work(w, `?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      expect(res.status).toBe(200);
      seen.push(...res.body.rows.map((r) => r.styleId));
      cursor = res.body.nextCursor;
      pages += 1;
    } while (cursor && pages < 10);

    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);

    /* Same request, same answer: the sort is total, not "whatever Mongo
       returned this time". */
    const again = await work(w, "?limit=2");
    expect(again.body.rows.map((r) => r.styleId)).toEqual(seen.slice(0, 2));
  });

  test("limit is bounded above and defaults conservatively", async () => {
    const w = await merchandiser();
    await style(w, { materials: { status: "pending", rawItems: [] } });
    expect((await work(w)).body.limit).toBe(styleWork.DEFAULT_LIMIT);
    expect((await work(w, "?limit=5000")).body.limit).toBe(styleWork.MAX_LIMIT);
  });

  test("a malformed filter, limit or cursor is refused without leaking anything", async () => {
    const w = await merchandiser();
    await style(w, { materials: { status: "pending", rawItems: [] } });

    for (const qs of ["?kind=EVERYTHING", "?limit=abc", "?limit=0", "?limit=1.5", "?cursor=not-a-cursor"]) {
      const res = await work(w, qs);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION");
      /* A refusal says what the caller sent wrong. It does not confirm what
         exists behind the filter. */
      expect(res.body.rows).toBeUndefined();
      expect(JSON.stringify(res.body)).not.toMatch(/Tee|styleId/);
    }
  });
});

/* ══ THE ALLOWLIST ════════════════════════════════════════════════════════ */

describe("what may leave", () => {
  /** Every word that would mean another department's fact had crossed. */
  const BANNED = [
    /journey/i, /enquiry/i, /customer/i, /account/i, /quotation/i, /supplier/i,
    /vendor/i, /\brate\b/i, /\bcost\b/i, /margin/i, /\btax\b/i, /\bgst\b/i,
    /consumption/i, /evidence/i, /measurement/i, /warehouse/i, /machine/i,
    /purchase.?order/i, /stock/i, /amountMinor/i, /\bprice\b/i,
  ];

  test("no response carries a foreign fact, on either endpoint", async () => {
    const w = await merchandiser();
    await charges(w.co);
    await style(w, {
      productName: "Full house",
      materials: {
        status: "pending",
        packagingSelections: [{ rowId: "a", rawItemId: new mongoose.Types.ObjectId(), status: "proposed" }],
      },
      sample: {
        serviceRequirements: [{
          rowId: "d1", purpose: "DEVELOPMENT_TOOLING", developmentSource: "COMPANY_POLICY",
          developmentChargeKey: "screen-making", included: true,
        }],
      },
      techSheet: {
        technical: {
          materials: [{
            rawItemId: new mongoose.Types.ObjectId(), rawItemName: "Shell fabric",
            consumptionPerPiece: 0.42, unit: "kg",
            returnedToMaterials: { reason: "Wrong GSM.", at: new Date() },
          }],
        },
      },
      bomApproval: { status: "rejected", note: "Trim missing." },
    });

    for (const res of [await overview(w), await work(w)]) {
      expect(res.status).toBe(200);
      const raw = JSON.stringify(res.body);
      for (const banned of BANNED) expect(raw).not.toMatch(banned);
    }
  });

  test("a work row holds exactly the allowlisted keys", async () => {
    const w = await merchandiser();
    await style(w, { materials: { status: "pending", rawItems: [] } });
    const { body } = await work(w);
    expect(Object.keys(body.rows[0]).sort()).toEqual(
      ["actions", "productName", "styleCode", "styleId", "styleRef", "updatedAt", "variantLabel"],
    );
    for (const action of body.rows[0].actions) {
      for (const key of Object.keys(action)) {
        expect(["kind", "label", "reason"]).toContain(key);
      }
    }
  });

  test("an overview holds counts and an as-of time, and nothing else", async () => {
    const w = await merchandiser();
    const { body } = await overview(w);
    expect(Object.keys(body).sort()).toEqual(["counts", "generatedAt", "success"]);
    expect(Object.keys(body.counts).sort())
      .toEqual([...styleWork.WORK_KINDS, "activeStyles", "stylesWithAction"].sort());
  });

  test("every count has a queue behind it that returns exactly those styles", async () => {
    const w = await merchandiser();
    await charges(w.co);
    await style(w, { materials: { status: "pending", rawItems: [] } });
    await style(w, { bomApproval: { status: "rejected", note: "No." } });

    const { body } = await overview(w);
    for (const kind of styleWork.WORK_KINDS) {
      const res = await work(w, `?kind=${kind}&limit=${styleWork.MAX_LIMIT}`);
      expect(res.body.rows).toHaveLength(body.counts[kind]);
    }
  });
});

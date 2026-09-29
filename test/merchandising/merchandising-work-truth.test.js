// test/merchandising/merchandising-work-truth.test.js
//
// EVERY PUBLISHED CONDITION HAS AN AUTHORITATIVE CLEARING RULE.
//
// A queue is only worth opening if the things on it can come off it. Three of
// the transitional work list's conditions could not:
//
//   · "materials not selected" read a flag whose gate was removed on
//     26 Aug 2026. A bill of materials the Project Manager had SIGNED OFF was
//     still being reported as an unmade pick, because the sign-off is recorded
//     somewhere else and nobody was reading it.
//   · "material returned for correction" read a field that is written once and
//     thereafter only preserved. Nothing clears it — not a route, not a
//     service, not a migration — so a material returned in March was this
//     week's work, and next week's, for ever.
//   · a COMPLETED or CANCELLED style stayed in the queue, because the bound
//     filtered `isActive` (a soft-delete flag) and never the style's own
//     lifecycle `status`.
//
// The first is corrected, the second is removed rather than guessed at, and the
// third is excluded everywhere — count, queue and portfolio alike.
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

async function merchandiser(label = "Truth") {
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
  await approveCharges(co._id, [{
    key: "pattern-development", label: "Pattern development", active: true,
    calculation: "FLAT_PER_RUN",
    rates: [{ amountMinor: 500000, currency: "INR", effectiveFrom: new Date("2026-01-01") }],
  }]);

  const email = `mt${n}@grav.test`;
  const emp = await Employee.create({
    firstName: "M", lastName: `T${n}`, email, biometricId: `MT${n}`,
    isActive: true, gender: "Other", department: "Merch",
  });
  await DeptUser.create({
    name: "User", email, passwordHash: "x", isAdmin: false, isActive: true,
    departmentId: new mongoose.Types.ObjectId(), employeeRef: emp._id,
  });
  await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: emp._id, personName: "M" });
  await DepartmentRole.create({
    departmentSlug: "merchandiser", email, name: "User", role: "viewer", isActive: true,
    departmentId: new mongoose.Types.ObjectId(),
  });

  return {
    co, journey, enquiry,
    t: {
      company: co._id,
      token: jwt.sign(
        { id: String(emp._id), email, name: "M", role: "employee", employeeId: emp.biometricId },
        process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" },
      ),
    },
  };
}

/** A style with an explicit "no development needed" answer, so it is otherwise silent. */
const style = (w, overrides = {}) => SampleStyle.create({
  sampleStyleId: `SS-T-${++seq}`, styleCode: `SC-T-${seq}`, productName: `Tee ${seq}`,
  journeyId: w.journey._id, enquiryId: w.enquiry._id,
  stage: "materials",
  materials: { status: "selected", rawItems: [] },
  sample: {
    serviceRequirements: [{
      rowId: `d-${seq}`, purpose: "DEVELOPMENT_TOOLING",
      included: false, excludedReason: "This style is unbranded.",
    }],
  },
  ...overrides,
});

const overview = (w) => call("/overview", w.t);
const work = (w, qs = "") => call(`/work${qs}`, w.t);

/* ══ MATERIALS: THE BOM SIGN-OFF IS THE CLOSING FACT ══════════════════════ */

describe("materials", () => {
  test("an unsettled pick with no BOM sign-off is open", async () => {
    const w = await merchandiser();
    await style(w, { materials: { status: "pending", rawItems: [] } });
    expect((await overview(w)).body.counts.MATERIALS_UNANSWERED).toBe(1);
  });

  test("an APPROVED bill of materials closes it, whatever the retired flag says", async () => {
    /* This is the correction. The Project Manager signed off this very pick;
       `materials.status` never caught up because its own gate was removed. The
       queue used to report the style as an unmade selection for ever. */
    const w = await merchandiser();
    await style(w, {
      materials: { status: "pending", rawItems: [] },
      bomApproval: { status: "approved", round: 1, decidedAt: new Date(), decidedByName: "PM" },
    });

    const { body } = await overview(w);
    expect(body.counts.MATERIALS_UNANSWERED).toBe(0);
    expect(body.counts.stylesWithAction).toBe(0);
    expect((await work(w)).body.rows).toEqual([]);
  });

  test("a BOM still with the Project Manager is not Merchandising's either", async () => {
    /* `pending` means the request is out and the decision is somebody else's.
       It is not approved, so it does not CLOSE the question — but the pick is
       settled, so the legacy clause does not open it. */
    const w = await merchandiser();
    await style(w, {
      materials: { status: "selected", rawItems: [] },
      bomApproval: { status: "pending", round: 1, requestedAt: new Date() },
    });
    expect((await overview(w)).body.counts.MATERIALS_UNANSWERED).toBe(0);
  });

  test("a rejected BOM is reported once, as a rejection — not twice", async () => {
    /* A rejection is Merchandising's work and has its own kind, with the note
       saying what to fix. `bomApproval.status` is not `approved`, so if the
       legacy clause also fired the style would carry two labels for one fact.
       It does not, because the pick itself is settled. */
    const w = await merchandiser();
    await style(w, {
      materials: { status: "selected", rawItems: [] },
      bomApproval: { status: "rejected", note: "Trim missing." },
    });

    const { body } = await overview(w);
    expect(body.counts.BOM_APPROVAL_REJECTED).toBe(1);
    expect(body.counts.MATERIALS_UNANSWERED).toBe(0);
    expect(body.counts.stylesWithAction).toBe(1);

    const rows = (await work(w)).body.rows;
    expect(rows[0].actions.map((a) => a.kind)).toEqual(["BOM_APPROVAL_REJECTED"]);
  });

  test("the legacy clause is one named thing, and it still reads legacy records", async () => {
    /* A record written before the BOM gate existed carries no `bomApproval` at
       all. The clause that reads it is exported by name so it can be deleted
       in one place when those records are settled or migrated. */
    const w = await merchandiser();
    const legacy = await SampleStyle.create({
      sampleStyleId: `SS-LEG-${++seq}`, productName: "Legacy tee",
      journeyId: w.journey._id, stage: "materials",
      materials: { status: "pending", rawItems: [] },
      sample: {
        serviceRequirements: [{
          rowId: "d", purpose: "DEVELOPMENT_TOOLING", included: false, excludedReason: "n/a",
        }],
      },
    });
    const stored = await SampleStyle.findById(legacy._id).lean();
    expect(stored.bomApproval?.status || "none").toBe("none");

    expect(styleWork.legacyMaterialsPickUnsettled(stored)).toBe(true);
    expect(styleWork.LEGACY_MATERIALS_PICK_UNSETTLED).toEqual({
      "materials.status": { $ne: "selected" },
    });
    expect((await overview(w)).body.counts.MATERIALS_UNANSWERED).toBe(1);
  });

  test("a submission sitting with Sales is still nobody's work here", async () => {
    const w = await merchandiser();
    await style(w, {
      materials: { status: "pending", rawItems: [] },
      materialsChangeLog: [{ items: ["Cotton"], status: "pending" }],
    });
    expect((await overview(w)).body.counts.MATERIALS_UNANSWERED).toBe(0);
  });
});

/* ══ THE RETURNED MATERIAL IS GONE, AND STAYS GONE ════════════════════════ */

describe("returned materials", () => {
  test("are not a published work kind", async () => {
    expect(styleWork.WORK_KINDS).not.toContain("MATERIAL_RETURNED");
    expect(styleWork.WORK_KIND.MATERIAL_RETURNED).toBeUndefined();
  });

  test("a style whose only fact is a historical return is not open work", async () => {
    /* The return happened. Nothing in the schema says whether it is resolved,
       and nothing clears it — so reporting it would be reporting it for ever. */
    const w = await merchandiser();
    await style(w, {
      techSheet: {
        technical: {
          materials: [{
            rawItemId: new mongoose.Types.ObjectId(), rawItemName: "Shell fabric",
            returnedToMaterials: { reason: "Wrong GSM.", at: new Date("2026-03-01") },
          }],
        },
      },
    });

    const { body } = await overview(w);
    expect(body.counts.stylesWithAction).toBe(0);
    expect(body.counts).not.toHaveProperty("MATERIAL_RETURNED");
    expect((await work(w)).body.rows).toEqual([]);
    expect((await work(w)).body.kinds).not.toContain("MATERIAL_RETURNED");
  });

  test("the reason is not published anywhere, and the record is not even read", async () => {
    const w = await merchandiser();
    await style(w, {
      materials: { status: "pending", rawItems: [] },
      techSheet: {
        technical: {
          materials: [{
            rawItemId: new mongoose.Types.ObjectId(), rawItemName: "Shell fabric",
            consumptionPerPiece: 0.42, unit: "kg",
            returnedToMaterials: { reason: "Wrong GSM.", at: new Date() },
          }],
        },
      },
    });

    const raw = JSON.stringify((await work(w)).body);
    expect(raw).not.toMatch(/Wrong GSM/);
    expect(raw).not.toMatch(/Shell fabric/);
    /* And the projection does not ask for R&D's technical record at all. */
    expect(styleWork.PROJECTION).not.toMatch(/techSheet/);
  });

  test("asking for it as a filter is refused, not silently ignored", async () => {
    const w = await merchandiser();
    const res = await work(w, "?kind=MATERIAL_RETURNED");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION");
  });
});

/* ══ TERMINAL STYLES ARE NOT OPEN WORK ════════════════════════════════════ */

describe("terminal styles", () => {
  test("a completed or cancelled style is in no count and no queue", async () => {
    const w = await merchandiser();
    /* Every one of them would otherwise be open work: unsettled materials, a
       proposed component, an unanswered development section, a rejected BOM. */
    const open = {
      materials: {
        status: "pending",
        packagingSelections: [{ rowId: "a", rawItemId: new mongoose.Types.ObjectId(), status: "proposed" }],
      },
      sample: { serviceRequirements: [] },
      bomApproval: { status: "rejected", note: "Trim missing." },
    };
    await style(w, { productName: "Completed tee", status: "completed", ...open });
    await style(w, { productName: "Cancelled tee", status: "cancelled", ...open });

    const { body } = await overview(w);
    expect(body.counts.activeStyles).toBe(0);
    expect(body.counts.stylesWithAction).toBe(0);
    for (const kind of styleWork.WORK_KINDS) expect([kind, body.counts[kind]]).toEqual([kind, 0]);
    expect((await work(w)).body.rows).toEqual([]);
  });

  test("an empty development section on a terminal style is not open work", async () => {
    const w = await merchandiser();
    await style(w, {
      productName: "Done tee", status: "completed", sample: { serviceRequirements: [] },
    });
    expect((await overview(w)).body.counts.DEVELOPMENT_INCOMPLETE).toBe(0);
  });

  test("the same style, still active, IS open work — so the exclusion is the status", async () => {
    const w = await merchandiser();
    await style(w, {
      productName: "Live tee", status: "active", sample: { serviceRequirements: [] },
    });
    expect((await overview(w)).body.counts.DEVELOPMENT_INCOMPLETE).toBe(1);
  });

  test("a style with no status at all is not assumed terminal", async () => {
    /* The field defaults to `active`; a record without one predates it, and
       absence is not proof of completion. */
    const w = await merchandiser();
    await SampleStyle.collection.insertOne({
      sampleStyleId: `SS-NOSTATUS-${++seq}`, productName: "Statusless",
      journeyId: w.journey._id, stage: "materials", isActive: true,
      materials: { status: "pending" },
      createdAt: new Date(), updatedAt: new Date(),
    });
    expect((await overview(w)).body.counts.activeStyles).toBe(1);
  });
});

/* ══ ONE SET OF RULES FOR THE COUNT AND THE LIST ══════════════════════════ */

describe("count and list parity", () => {
  /** A portfolio holding every shape the rules have an opinion about. */
  async function portfolio(w) {
    await style(w, { productName: "Materials open", materials: { status: "pending", rawItems: [] } });
    await style(w, {
      productName: "Packaging open",
      materials: {
        status: "selected",
        packagingSelections: [
          { rowId: "a", rawItemId: new mongoose.Types.ObjectId(), status: "proposed" },
          { rowId: "b", rawItemId: new mongoose.Types.ObjectId(), status: "approved" },
        ],
      },
    });
    await style(w, { productName: "Development open", sample: { serviceRequirements: [] } });
    await style(w, { productName: "BOM rejected", bomApproval: { status: "rejected", note: "No." } });
    await style(w, {
      productName: "Several open", materials: { status: "pending", rawItems: [] },
      sample: { serviceRequirements: [] },
      bomApproval: { status: "rejected", note: "No." },
    });
    await style(w, { productName: "Nothing open" });
    await style(w, { productName: "Terminal", status: "completed", materials: { status: "pending" } });
    /* And a foreign company's style with everything open. */
    const other = await merchandiser("Foreign");
    await style(other, { productName: "Foreign open", materials: { status: "pending", rawItems: [] } });
  }

  test("every published kind's count equals its own filtered result set", async () => {
    const w = await merchandiser();
    await portfolio(w);
    const { body } = await overview(w);

    for (const kind of styleWork.WORK_KINDS) {
      const rows = (await work(w, `?kind=${kind}&limit=${styleWork.MAX_LIMIT}`)).body.rows;
      expect([kind, rows.length]).toEqual([kind, body.counts[kind]]);
      /* And every row states the reason it is in that list. */
      for (const row of rows) expect(row.actions.map((a) => a.kind)).toEqual([kind]);
    }
  });

  test("`stylesWithAction` equals the unfiltered queue, and each row has a reason", async () => {
    const w = await merchandiser();
    await portfolio(w);
    const { body } = await overview(w);

    const rows = (await work(w, `?limit=${styleWork.MAX_LIMIT}`)).body.rows;
    expect(rows).toHaveLength(body.counts.stylesWithAction);
    for (const row of rows) expect(row.actions.length).toBeGreaterThan(0);

    /* A style with several open things is ONE row carrying several actions. */
    const several = rows.find((r) => r.productName === "Several open");
    expect(several.actions.map((a) => a.kind).sort())
      .toEqual(["BOM_APPROVAL_REJECTED", "DEVELOPMENT_INCOMPLETE", "MATERIALS_UNANSWERED"]);
  });

  test("neither the counts nor the queue can see a terminal or foreign style", async () => {
    const w = await merchandiser();
    await portfolio(w);

    const rows = (await work(w, `?limit=${styleWork.MAX_LIMIT}`)).body.rows;
    const names = rows.map((r) => r.productName);
    expect(names).not.toContain("Terminal");
    expect(names).not.toContain("Foreign open");
    expect((await overview(w)).body.counts.activeStyles).toBe(6);
  });

  test("paging the queue yields exactly the counted set, with no client filtering", async () => {
    /* The count is the database's answer and so is every page. A queue that
       fetched a first N and filtered in the browser would drift from its own
       heading the moment the portfolio outgrew N. */
    const w = await merchandiser();
    await portfolio(w);
    const expected = (await overview(w)).body.counts.stylesWithAction;

    const seen = [];
    let cursor = null;
    let pages = 0;
    do {
      const res = await work(w, `?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      seen.push(...res.body.rows.map((r) => r.styleId));
      cursor = res.body.nextCursor;
      pages += 1;
    } while (cursor && pages < 20);

    expect(seen).toHaveLength(expected);
    expect(new Set(seen).size).toBe(expected);
  });
});

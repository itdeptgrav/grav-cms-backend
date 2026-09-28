// test/merchandising/demo-sales-adoption.test.js
//
// LANE B'S CLAIMS ABOUT THE SHOWCASE ORDER, PROVED AT RUNTIME.
//
// `demo-complete-file.test.js` holds the whole seed to the standard it deserves: a
// single note is a failure, because a demo assembled out of half-completed steps
// shows a state the product cannot reach. That is the right rule and it stays.
//
// It also means that while ANY step is incomplete, every assertion in that suite is
// unreachable — including the ones about Sales requirements and Development
// requirement adoption, which have nothing to do with the incomplete step. Lane A is
// mid-migration on the Time & Action template contract, so the T&A step currently
// records a note.
//
// So this suite runs the same seed and asserts Lane B's own claims, tolerating notes
// ONLY from the Time & Action step and the pack gate that depends on it. Anything
// else still fails here, loudly, and the exception is written as a list of allowed
// prefixes rather than a blanket "ignore notes" — so the day Lane A lands, this
// stops tolerating and starts proving.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = "0".repeat(64);
/* ── THIS FILE BRINGS ITS OWN DATABASE ─────────────────────────────────────
   The shared setup clears every collection after every test, which is right for a
   route suite and wrong for this one: the demo is seeded once and then read from
   several angles. Without this flag the first assertion passes and every later one
   reads an empty database. The setup's own documented escape hatch, and it must be
   set before any require. */
process.env.TEST_WITHOUT_MONGO = "1";

const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

const DAY = 24 * 60 * 60 * 1000;
const day = (n) => new Date(Date.now() + n * DAY).toISOString().slice(0, 10);

/* The steps Lane A owns. A note from anything else is Lane B's problem. */
const LANE_A_STEPS = ["time & action", "pack submit", "pack refresh"];

let rs, company, maker, checker, seeded;

beforeAll(async () => {
  await mongoose.disconnect();
  rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  await mongoose.connect(rs.getUri(), { dbName: "merch_demo_lane_b" });

  const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
  const AccessDepartment = require("../../models/Access/AccessDepartment");
  const DepartmentRole = require("../../models/Access/DepartmentRole");
  const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");

  company = await Acc_Company.create({
    companyName: "GRAV Demo Garments", booksFromDate: new Date("2026-04-01"),
  });
  const department = await AccessDepartment.create({
    key: "merchandiser", slug: "merchandiser", name: "Merchandising",
    dashboardPath: "/merchandiser/dashboard", isActive: true,
  });
  maker = { id: new mongoose.Types.ObjectId(), email: "merch.demo@grav.local", name: "Aisha Demo" };
  checker = { id: new mongoose.Types.ObjectId(), email: "merch.approver@grav.local", name: "Rahul Demo" };
  for (const who of [maker, checker]) {
    await DepartmentRole.create({
      departmentSlug: "merchandiser", departmentId: department._id,
      email: who.email, name: who.name, role: "owner",
    });
    await SpCompanyMembership.create({
      companyId: company._id, email: who.email, personName: who.name,
    });
  }

  seeded = await require("../../scripts/demo/merchandising-demo-complete-file")({
    company, maker, checker, day,
  });
}, 180000);

afterAll(async () => {
  await mongoose.disconnect();
  if (rs) await rs.stop();
});

const ctx = () => ({ companyId: company._id, actorId: maker.id, actorName: maker.name });

test("no step Lane B owns reported a problem", async () => {
  /* The exception, stated as a list. A note from the development-requirements step,
     the handover, the selections or the change control still fails here. */
  const mine = (seeded.notes || []).filter(
    (n) => !LANE_A_STEPS.some((step) => String(n).startsWith(`${step}:`)),
  );
  expect(mine).toEqual([]);
});

test("Sales confirmed embroidery and washing, and did not confirm printing", async () => {
  /* Read from the immutable Sales version the file accepted — the record itself,
     not a view of it. */
  const ExecutionFile = require("../../models/CMS_Models/Merchandising/ExecutionFile");
  const SalesHandoverVersion = require("../../models/CMS_Models/Sales/SalesHandoverVersion");
  const file = await ExecutionFile.findById(seeded.fileId).lean();
  const version = await SalesHandoverVersion.findById(file.currentHandoverVersionId).lean();

  const statement = version.executionProjection.processRequirements;
  const stated = Object.fromEntries(
    (statement.processes || []).map((p) => [p.process, p.requirement]),
  );
  expect(stated).toEqual({
    EMBROIDERY: "REQUIRED",
    WASHING: "REQUIRED",
    PRINTING: "NOT_REQUIRED",
  });
  /* And each definite answer cites the authority it rests on. */
  for (const p of statement.processes) {
    expect(p.evidence).toBeTruthy();
    expect(p.buyerSpecification).toBeTruthy();
  }
});

test("embroidery and washing are COVERED, printing is confirmed not required", async () => {
  const intake = require("../../services/merchandising/salesProcessIntake.service");
  const out = await intake.reconcile(ctx(), { fileId: seeded.fileId });

  expect(Object.fromEntries(out.findings.map((f) => [f.process, f.state]))).toEqual({
    EMBROIDERY: "COVERED",
    WASHING: "COVERED",
    PRINTING: "CONFIRMED_NOT_REQUIRED",
  });
  expect(out.blocking).toEqual([]);
  expect(out.maySubmit).toBe(true);
});

test("there is no print requirement, fabricated or otherwise", async () => {
  const selection = require("../../services/merchandising/selection.service");
  const current = await selection.getCurrent(ctx(), {
    fileId: seeded.fileId, family: "DEVELOPMENT",
  });
  const rows = current.approved?.rows || current.working?.rows || [];
  expect(rows.some((r) => r.requirementType === "PRINT")).toBe(false);
  /* And no row excuses a disagreement with Sales, which is how the print row used
     to survive reconciliation. */
  for (const r of rows) {
    expect(String(r.coordinationNote || ""))
      .not.toMatch(/kept deliberately|despite Sales|no print/i);
  }
});

test("the adopted rows retain their Sales provenance", async () => {
  const selection = require("../../services/merchandising/selection.service");
  const current = await selection.getCurrent(ctx(), {
    fileId: seeded.fileId, family: "DEVELOPMENT",
  });
  const rows = current.approved?.rows || current.working?.rows || [];

  const fromSales = rows.filter((r) => r.sourceRef?.app === "sales");
  expect(fromSales.map((r) => r.requirementType).sort()).toEqual(["EMBROIDERY", "WASH"]);
  for (const r of fromSales) {
    /* The exact statement, by version — so a reader can follow it to the buyer's
       own words. A hand-typed row could carry none of this. */
    expect(r.sourceRef.recordType).toBe("handover_version");
    expect(r.sourceRef.sourceVersion).toBe("1");
    expect(String(r.sourceRef.recordRef)).toMatch(/#(EMBROIDERY|WASHING)$/);
    /* And the two answers nothing invents were supplied by a person. */
    expect(r.responsibleApplication).toBe("PRODUCT_DEVELOPMENT");
    expect(r.requiredByDate).toBeTruthy();
  }

  /* The rest are Merchandising's own judgement, with no borrowed authority. */
  const own = rows.filter((r) => !r.sourceRef?.app);
  expect(own.map((r) => r.requirementType).sort())
    .toEqual(["ARTWORK", "OTHER", "PRE_PRODUCTION_SAMPLE"]);
});

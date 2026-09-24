// test/merchandising/demo-complete-file.test.js
//
// THE SHOWROOM'S COMPLETE FILE — WHAT IT MAY SEED, AND WHERE IT MAY SEED IT.
//
// The demo exists to be looked at, which makes it exactly the kind of code
// that quietly grows a shortcut: a status written straight into a collection
// because the service refused it, a supplier name in a trim row because the
// screen looked empty without one, a connection string that was convenient on
// somebody's machine. Each of those turns a review of the product into a
// review of a fiction.
//
// So this seeds the whole file into an in-memory replica set and holds it to
// the same rules the application is held to:
//
//   1  the showroom refuses a database that is not loopback, and never reads
//      a configured one;
//   2  the complete file exists, with the buyer, style and quantity asked for;
//   3  the delivery drops and the colourway splits both add to the confirmed
//      quantity, and the split-by-drop mapping adds to both;
//   4  all five sections of the file have real records behind them;
//   5  nobody approves their own work — the maker and the checker differ on
//      every approval, baseline and issued minute;
//   6  no supplier, rate, cost, stock, consumption or production-release fact
//      is anywhere in a Merchandising-owned record.

/* ── THIS FILE BRINGS ITS OWN DATABASE ─────────────────────────────────────
   The shared setup clears every collection after every test, which is right
   for a route suite and wrong for this one: the demo file is seeded once,
   through a dozen services, and then READ from a dozen angles. Re-seeding it
   per assertion would turn a three-minute suite into a twenty-minute one and
   prove nothing extra. The flag is the setup's own documented escape hatch,
   and it must be set before any require. */
process.env.TEST_WITHOUT_MONGO = "1";

const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

jest.setTimeout(180000);

const day = (offset) => {
  const value = new Date();
  value.setUTCHours(12, 0, 0, 0);
  value.setUTCDate(value.getUTCDate() + offset);
  return value.toISOString().slice(0, 10);
};

let rs;
let seeded;
let company;
let maker;
let checker;

beforeAll(async () => {
  process.env.SALARY_ENCRYPTION_KEY = "0".repeat(64);
  await mongoose.disconnect();
  rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  await mongoose.connect(rs.getUri(), { dbName: "merch_demo_complete" });

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
  /* ── A SEED NOTE IS A FAILURE, WITHOUT EXCEPTION ───────────────────────
     Every note is something the seeder asked a service for and did not get:
     a refused pack refresh, a refused submission, a section that populated
     halfway. A demo assembled out of those is a demo that shows a state the
     product cannot reach, and the whole point of seeding through the real
     services is that it cannot. There is no allowed note. */
  if ((seeded.notes || []).length) {
    throw new Error(`the demo seed did not complete: ${seeded.notes.join(" / ")}`);
  }
});

afterAll(async () => {
  await mongoose.disconnect();
  if (rs) await rs.stop();
});

const ctx = () => ({ companyId: company._id });

/* ══ 1 — WHERE IT IS ALLOWED TO WRITE ═════════════════════════════════════ */

describe("the showroom writes to a disposable local database and nothing else", () => {
  const showroom = fs.readFileSync(
    path.join(__dirname, "../../scripts/demo/merchandising-demo-server.js"), "utf8",
  );

  test("it refuses a database that is not loopback", () => {
    expect(showroom).toMatch(/if \(!\/\^mongodb:\\\/\\\/\(127\\\.0\\\.0\\\.1\|localhost\):\/\.test\(uri\)\) throw/);
    expect(showroom).toMatch(/Demo database must bind to loopback/);
  });

  test("its database is in memory, and stopping the process discards it", () => {
    expect(showroom).toMatch(/MongoMemoryReplSet\.create/);
    expect(showroom).toMatch(/await mongo\.stop\(\)/);
  });

  test("it passes the child server no configured credential", () => {
    /* The env handed to the child is written out in full, so a reader can see
       there is no Atlas URI, no real Firebase key and no mail credential in
       it. `MONGODB_URI` is the in-memory one this process just started. */
    const env = showroom.slice(showroom.indexOf("const env = {"), showroom.indexOf("child = spawn"));
    expect(env).toMatch(/MONGODB_URI: uri/);
    expect(env).toMatch(/grav-local-demo-invalid/);
    for (const banned of [
      /mongodb\+srv/i, /atlas/i, /BREVO/i, /CLOUDINARY/i, /LIVEKIT/i,
      /GOOGLE_SERVICE_ACCOUNT/i, /TEAMOFFICE/i, /GEMINI/i,
    ]) {
      expect(env).not.toMatch(banned);
    }
  });

  test("it refuses to start against a source copy that has a .env", () => {
    expect(showroom).toMatch(/existsSync\(require\("path"\)\.join\(backendDir, "\.env"\)\)/);
    expect(showroom).toMatch(/Set MERCH_DEMO_BACKEND_DIR to a clean source copy without \.env/);
  });

  test("the seeder sends nothing anywhere", () => {
    const seeder = fs.readFileSync(
      path.join(__dirname, "../../scripts/demo/merchandising-demo-complete-file.js"), "utf8",
    );
    for (const banned of [/fetch\(/, /axios/, /nodemailer/, /sendMail/i, /webhook/i, /https?\.request/]) {
      expect(seeder).not.toMatch(banned);
    }
  });
});

/* ══ 2 & 3 — THE ORDER, AND ITS ARITHMETIC ═══════════════════════════════ */

describe("the complete file is the order it says it is", () => {
  test("it exists, with the buyer, style and quantity the demo asks for", async () => {
    const execution = require("../../services/merchandising/execution.service");
    const { file } = await execution.getFile(ctx(), { id: seeded.fileId });
    expect(file.fileNumber).toBe("MEF-DEMO-COMPLETE-001");
    expect(file.buyerDisplayLabel).toBe("Northstar Apparel");
    expect(file.styleRef).toBe("OS-307");
    expect(file.buyerStyleRef).toBe("NW-UTILITY-26");
    expect(file.productName).toBe("Women's utility overshirt");
    expect(file.totalQuantity).toBe(640);
    expect(file.lifecycleStatus).toBe("OPEN");
    expect(file.responsibleMerchandiser?.name).toBe("Aisha Demo");
    expect(file.coordinationNote.length).toBeGreaterThan(40);
  });

  test("the drops, the colourways and the split-by-drop mapping all add to 640", async () => {
    const execution = require("../../services/merchandising/execution.service");
    const { file } = await execution.getFile(ctx(), { id: seeded.fileId });
    const SalesHandoverVersion = require("../../models/CMS_Models/Sales/SalesHandoverVersion");
    const version = await SalesHandoverVersion.findById(file.currentVersion.id).lean();
    const p = version.executionProjection;

    const sum = (rows) => rows.reduce((t, r) => t + Number(r.quantity || 0), 0);
    expect(sum(p.deliveries)).toBe(640);
    expect(sum(p.breakdown)).toBe(640);
    expect(sum(p.allocations)).toBe(640);
    /* And each drop's allocations add to that drop. A mapping that balances
       overall but not per drop is the kind of error a demo hides. */
    for (const drop of p.deliveries) {
      const forDrop = p.allocations.filter((a) => a.dropRef === drop.dropRef);
      expect(sum(forDrop)).toBe(drop.quantity);
    }
    for (const split of p.breakdown) {
      const forSplit = p.allocations.filter((a) => a.lineSplitRef === split.lineSplitRef);
      expect(sum(forSplit)).toBe(split.quantity);
    }
    /* The execution units the acceptance minted carry the same total. */
    expect(sum(file.units.filter((u) => u.active))).toBe(640);
  });

  test("the ex-factory dates are ahead of today, whenever the showroom runs", async () => {
    const execution = require("../../services/merchandising/execution.service");
    const { file } = await execution.getFile(ctx(), { id: seeded.fileId });
    for (const d of file.deliveries) {
      expect(new Date(d.targetExFactoryDate).getTime()).toBeGreaterThan(Date.now());
      expect(new Date(d.committedDeliveryDate).getTime())
        .toBeGreaterThan(new Date(d.targetExFactoryDate).getTime());
    }
  });
});

/* ══ 4 — EVERY SECTION HAS RECORDS BEHIND IT ═════════════════════════════ */

describe("all five sections have something real in them", () => {
  test("Order Brief: an accepted Sales version, with the buyer's instructions", async () => {
    const execution = require("../../services/merchandising/execution.service");
    const { file } = await execution.getFile(ctx(), { id: seeded.fileId });
    expect(file.currentVersion?.versionNo).toBe(1);
    expect(file.packingRequirement).toMatch(/polybag/i);
    expect(file.testingRequirement).toMatch(/colour-fastness/i);
    expect(file.deliveryRequirement).toMatch(/Ex-factory/i);
  });

  test("Product Requirements: three approved revisions, and a superseded one", async () => {
    const selection = require("../../services/merchandising/selection.service");
    const seen = {};
    for (const family of ["MATERIAL_TRIM", "PACKAGING", "DEVELOPMENT"]) {
      const current = await selection.getCurrent(ctx(), { fileId: seeded.fileId, family });
      expect(current.approved).toBeTruthy();
      expect(current.approved.rows.length).toBeGreaterThanOrEqual(6);
      seen[family] = current.approved.revisionNo;
    }
    /* The buyer's change produced a second packaging revision; the first is
       superseded and still readable. */
    const { MaterialTrimRevision, PackagingRevision } =
      require("../../models/CMS_Models/Merchandising/SelectionRevision");
    expect(seen.PACKAGING).toBe(2);
    const superseded = await PackagingRevision.findOne({
      fileId: seeded.fileId, state: "SUPERSEDED",
    }).lean();
    expect(superseded.revisionNo).toBe(1);
    expect(superseded.rows.length).toBeGreaterThan(0);
    /* Materials carries the trim change the same way. */
    expect(await MaterialTrimRevision.countDocuments({ fileId: seeded.fileId })).toBe(2);
  });

  test("Approvals & PP Meeting: a register, and an issued minute", async () => {
    const approvals = require("../../services/merchandising/approvalRegister.service");
    const register = await approvals.readRegister(ctx(), { fileId: seeded.fileId });
    expect(register.rows.length).toBeGreaterThanOrEqual(8);
    const internal = register.rows.filter((r) => r.internallyOwned);
    expect(internal.length).toBe(3);
    for (const row of internal) expect(row.status).toBe("APPROVED");
    /* Every externally-owned row reads as awaiting its source, because no
       application in this repository publishes one yet. The demo does not
       invent a decision on another department's behalf. */
    for (const row of register.rows.filter((r) => !r.internallyOwned)) {
      expect(["AWAITING_SOURCE_RECORD", "UNAVAILABLE"]).toContain(row.status);
    }

    const ppm = require("../../services/merchandising/preProductionMeeting.service");
    const current = await ppm.getCurrent(ctx(), { fileId: seeded.fileId });
    expect(current.issued.state).toBe("ISSUED");
    expect(current.issued.attendees.length).toBeGreaterThanOrEqual(7);
    expect(current.issued.reviewNotes.length).toBeGreaterThanOrEqual(6);
    const statuses = current.issued.decisions.map((d) => d.status);
    expect(statuses).toEqual(expect.arrayContaining(["CLOSED", "OPEN", "NOT_APPLICABLE"]));
    expect(current.issued.decisions.some((d) => d.externalTaskRef)).toBe(true);
    /* A decision owned by a department that is not Merchandising. */
    expect(current.issued.decisions.some((d) => d.ownerDepartment !== "MERCHANDISING")).toBe(true);
  });

  test("Schedule & Handover: a baselined plan in mixed states, and eight departments", async () => {
    const tnaPlan = require("../../services/merchandising/tnaPlan.service");
    const plan = await tnaPlan.getPlan(ctx(), { fileId: seeded.fileId });
    expect(plan.milestones.length).toBeGreaterThanOrEqual(10);
    expect(plan.plan.currentBaselineNo).toBe(1);
    const statuses = new Set(plan.milestones.map((m) => m.status));
    for (const wanted of ["COMPLETED", "OVERDUE", "FORECAST_LATE", "BLOCKED"]) {
      expect([...statuses]).toContain(wanted);
    }
    /* A baseline and a forecast that visibly differ — the reason the two
       columns exist. */
    expect(plan.milestones.some((m) => m.forecastDate && m.baselineDate
      && m.forecastDate !== m.baselineDate)).toBe(true);

    const departmentStatus = require("../../services/merchandising/departmentStatus.service");
    const register = await departmentStatus.register(ctx(), { fileId: seeded.fileId });
    expect(register.rows.length).toBe(8);
    const reported = register.rows.filter((r) => r.availability === "AVAILABLE");
    expect(reported.length).toBeGreaterThanOrEqual(6);
    for (const row of reported) {
      expect(row.sourceRecordRef).toBeTruthy();
      expect(row.sourceObservedAt || row.observedAt).toBeTruthy();
    }
    /* And one that has not spoken, which must not read as a zero. */
    expect(register.rows.some((r) => r.availability !== "AVAILABLE")).toBe(true);

    /* ── THE PACK IS SUBMITTED, AND PPC HAS NOT ANSWERED ────────────────
       The demo's whole point on this section is the handover as it really
       stands: Merchandising has declared its own work complete and sent
       version 1, and PPC's receipt is PPC's — pending, because nobody here
       may answer it. */
    const pack = require("../../services/merchandising/executionPack.service");
    const held = await pack.getPack(ctx(), { fileId: seeded.fileId });
    expect(held.pack).toBeTruthy();
    expect(held.pack.state).toBe("SUBMITTED");
    expect(held.pack.packVersionNo).toBe(1);
    expect(held.pack.declaration?.at).toBeTruthy();
    expect(held.pack.declaration?.byName).toBe(checker.name);
    /* What the pack RECORDED about the approvals matches what the register
       says — one reading, not two. */
    const position = held.pack.contents.approvalRegister;
    expect(position.outstandingCount).toBe(0);
    expect(position.position).toBe("COMPLETE");
    const internalEntries = position.entries
      .filter((e) => e.owningApplication === "MERCHANDISING");
    expect(internalEntries).toHaveLength(3);
    for (const entry of internalEntries) expect(entry.state).toBe("APPROVED");

    /* The receiver's own record, in the receiver's own words. */
    expect(held.receipt).toBeTruthy();
    expect(held.receipt.state).toBe("PENDING");

    /* And nothing here says PPC accepted it or released production. The
       check is on the RECEIPT, not on the whole document: the pack legitimately
       records when MERCHANDISING accepted the Sales handover, which is a
       different acceptance by a different department. */
    expect(held.receipt.state).not.toBe("ACCEPTED");
    expect(held.receipt.decidedByName).toBeFalsy();
    expect(held.receipt.decidedAt).toBeFalsy();
    expect(held.receipt.sentence).toMatch(/awaiting PPC/i);
    expect(JSON.stringify(held.pack.contents).toUpperCase())
      .not.toContain("RELEASED_TO_PRODUCTION");

    /* ── AND PPC'S COLLECTION IS EMPTY, WHICH IS THE POINT ──────────────
       The awaiting-decision state is not a row Merchandising wrote on PPC's
       behalf: it is the ABSENCE of PPC's row, said in words. A receipt
       document here would mean somebody outside PPC had created one. */
    const { DownstreamHandoverReceipt } = require("../../models/CMS_Models/PPC/DownstreamHandoverReceipt");
    expect(await DownstreamHandoverReceipt.countDocuments({ fileId: seeded.fileId })).toBe(0);
    expect(held.receipt.packVersionNo).toBe(1);
  });

  test("Changes & History: a Sales change, assessed, with mixed acknowledgements", async () => {
    const changeControl = require("../../services/merchandising/changeControl.service");
    const list = await changeControl.listChanges(ctx(), { fileId: seeded.fileId });
    expect(list.rows.length).toBe(1);
    const changeRef = list.rows[0].notice.changeRef;
    const change = await changeControl.getChange(ctx(), { fileId: seeded.fileId, changeRef });

    expect(change.notice.before).toBeTruthy();
    expect(change.notice.after).toBeTruthy();
    expect(change.notice.before.packingRequirement)
      .not.toBe(change.notice.after.packingRequirement);
    expect(change.receipt.state).toBe("ACKNOWLEDGED");
    expect(change.impact.state).toBe("COORDINATED");
    /* The revision the change PRODUCED — never the one it replaced, which
       stays readable in its own collection. */
    expect(change.impact.packagingImpact?.impacted).toBe(true);
    expect(change.impact.packagingImpact?.newRevisionNo).toBe(2);

    const states = (change.acknowledgements || []).map((a) => a.state);
    expect(new Set(states).size).toBeGreaterThanOrEqual(2);
    expect(states).toContain("PENDING");

    /* History is append-only and covers the file's life. */
    const { MerchandisingAuditEvent } = require("../../models/CMS_Models/Merchandising/MerchandisingEvent");
    const events = await MerchandisingAuditEvent.countDocuments({ fileId: seeded.fileId });
    expect(events).toBeGreaterThan(10);
  });
});

/* ══ 5 — NOBODY APPROVES THEIR OWN WORK ══════════════════════════════════ */

describe("maker and checker are different people, everywhere it matters", () => {
  test("every approved revision was approved by somebody who did not write it", async () => {
    const { MaterialTrimRevision, PackagingRevision, DevelopmentRevision } =
      require("../../models/CMS_Models/Merchandising/SelectionRevision");
    const all = [
      ...await MaterialTrimRevision.find({ fileId: seeded.fileId }).lean(),
      ...await PackagingRevision.find({ fileId: seeded.fileId }).lean(),
      ...await DevelopmentRevision.find({ fileId: seeded.fileId }).lean(),
    ].filter((r) => r.approvedBy?.email);
    expect(all.length).toBeGreaterThanOrEqual(4);
    for (const revision of all) {
      expect(revision.approvedBy.email).not.toBe(revision.createdBy?.email);
      expect(revision.approvedBy.email).not.toBe(revision.submittedBy?.email);
      expect(revision.approvedBy.email).toBe(checker.email);
    }
  });

  test("the minute was written up by one person and issued by another", async () => {
    const { PreProductionMeeting } = require("../../models/CMS_Models/Merchandising/PreProductionMeeting");
    const issued = await PreProductionMeeting.findOne({
      fileId: seeded.fileId, state: "ISSUED",
    }).lean();
    expect(issued.conductedBy.email).toBe(maker.email);
    expect(issued.issuedBy.email).toBe(checker.email);
    expect(issued.issuedBy.email).not.toBe(issued.conductedBy.email);
  });

  test("the baseline was approved by the checker", async () => {
    const { TnaBaseline } = require("../../models/CMS_Models/Merchandising/TnaPlan");
    const baseline = await TnaBaseline.findOne({ fileId: seeded.fileId, baselineNo: 1 }).lean();
    expect(baseline.approvedBy.email).toBe(checker.email);
  });
});

/* ══ 6 — WHAT MAY NOT BE IN A MERCHANDISING RECORD ═══════════════════════ */

describe("no other department's facts are seeded into Merchandising's records", () => {
  test("no supplier, rate, cost, stock or consumption on a selection row", async () => {
    const { MaterialTrimRevision, PackagingRevision, DevelopmentRevision } =
      require("../../models/CMS_Models/Merchandising/SelectionRevision");
    const rows = [
      ...await MaterialTrimRevision.find({ fileId: seeded.fileId }).lean(),
      ...await PackagingRevision.find({ fileId: seeded.fileId }).lean(),
      ...await DevelopmentRevision.find({ fileId: seeded.fileId }).lean(),
    ].flatMap((r) => r.rows || []);
    expect(rows.length).toBeGreaterThan(15);

    const BANNED_FIELDS = [
      "rate", "unitRate", "price", "unitPrice", "cost", "amount", "currency",
      "supplier", "supplierId", "vendor", "quotation", "purchaseOrder",
      "leadTime", "stock", "stockQuantity", "lot", "consumption", "wastage",
    ];
    for (const row of rows) {
      for (const field of BANNED_FIELDS) {
        expect(row[field]).toBeUndefined();
      }
    }
  });

  test("and none of those words is smuggled into a specification either", async () => {
    const { MaterialTrimRevision, PackagingRevision } =
      require("../../models/CMS_Models/Merchandising/SelectionRevision");
    const text = [
      ...await MaterialTrimRevision.find({ fileId: seeded.fileId }).lean(),
      ...await PackagingRevision.find({ fileId: seeded.fileId }).lean(),
    ].flatMap((r) => (r.rows || []).map((row) => [
      row.specification, row.notes, row.componentName,
    ].join(" "))).join(" \n ");
    for (const banned of [
      /\bsupplier\b/i, /\bvendor\b/i, /\bpurchase order\b/i, /\bper piece cost\b/i,
      /₹/, /\bUSD\b/, /\bunit rate\b/i, /\bstock on hand\b/i, /\bconsumption\b/i,
    ]) {
      expect(text).not.toMatch(banned);
    }
  });

  test("Merchandising released nothing to production, and marked nobody ready", async () => {
    const departmentStatus = require("../../services/merchandising/departmentStatus.service");
    const register = await departmentStatus.register(ctx(), { fileId: seeded.fileId });
    /* Every reported row is attributed to the department that reported it. */
    for (const row of register.rows.filter((r) => r.availability === "AVAILABLE")) {
      expect(row.attribution).toMatch(/as reported by/i);
    }
    /* Nothing claims production release. */
    expect(register.rows.some((r) => r.statusCode === "RELEASED_TO_PRODUCTION")).toBe(false);

    const { PreProductionMeeting } = require("../../models/CMS_Models/Merchandising/PreProductionMeeting");
    const issued = await PreProductionMeeting.findOne({ fileId: seeded.fileId, state: "ISSUED" }).lean();
    const words = JSON.stringify(issued).toLowerCase();
    for (const banned of ["ready for production", "production released", "cleared for production"]) {
      expect(words).not.toContain(banned);
    }
  });
});

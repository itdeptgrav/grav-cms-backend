// test/costing/rnd-technical-record.test.js
//
// R&D OWNS CONSUMPTION AND SAM. MERCHANDISING OWNS THE SHORTLIST.
//
// ── THE MISTAKE THIS PINS SHUT ──────────────────────────────────────────────
// The Merchandiser's materials pick REQUIRED a quantity, and that figure was
// then read downstream as the final per-garment consumption and displayed as
// established — "0.2625 kg + 5%" — when nobody had measured the garment.
// Merchandising selects WHICH materials; R&D establishes WHAT EACH CONSUMES,
// in a structured record Sales approves and a costing reads.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const express = require("express");
const mongoose = require("mongoose");

jest.mock("../../Middlewear/SalesAuthMiddlewear", () => {
  const mw = (req, res, next) => {
    const raw = req.headers["x-test-user"];
    if (!raw) return res.status(401).json({ success: false, message: "Authentication required." });
    req.user = JSON.parse(raw);
    next();
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
const SampleStyle = require("../../models/CMS_Models/Sales/SampleStyle");
const Account = require("../../models/CMS_Models/Sales/Account");
const Operation = require("../../models/CMS_Models/Inventory/Configurations/Operation");
const RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");
const StockItem = require("../../models/CMS_Models/Inventory/Products/StockItem");
const svc = require("../../services/centralCosting/technicalRecord.service");
const { approvedShortlistFor } = require("../../services/approvedMaterialShortlist.service");
const { stockItemBom } = require("../../services/sampleStyleEmail.service");

let server, base, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/cms/crm/sample-styles", require("../../routes/CMS_Routes/Sales/sampleStyles"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/cms/crm/sample-styles`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

const call = (path, { method = "GET", body, user } = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(user ? { "x-test-user": JSON.stringify(user) } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

/** A company, a member, a style with an approved two-material shortlist. */
async function world() {
  const n = ++seq;
  const co = await Acc_Company.create({ companyName: `Tech ${n}`, booksFromDate: new Date("2026-04-01") });
  const email = `tech-${n}@test.com`;
  const emp = await Employee.create({
    firstName: "R", lastName: `T${n}`, email, biometricId: `TC${n}`,
    isActive: true, gender: "Other", department: "Tech",
  });
  await DeptUser.create({
    name: "Admin", email, passwordHash: "x", isAdmin: true, isActive: true,
    departmentId: new mongoose.Types.ObjectId(), employeeRef: emp._id,
  });
  await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: emp._id, personName: "R" });

  const account = await Account.create({ companyId: co._id, companyName: `Buyer ${n}`, status: "active" });
  const journey = await SalesJourney.create({
    journeyId: `SJ-TC-${n}`, companyId: co._id, name: `J${n}`,
    accountId: account._id, ownerId: new mongoose.Types.ObjectId(), ownerName: "O",
  });

  const [shell, thread] = await RawItem.create([
    { name: `Shell fabric ${n}`, sku: `SHELL-${n}`, createdBy: emp._id },
    { name: `Thread ${n}`, sku: `THR-${n}`, createdBy: emp._id },
  ]);

  const style = await SampleStyle.create({
    sampleStyleId: `SS-2026-${String(7000 + n)}`, styleCode: `SC-TC-${n}`,
    productName: "Soumya Tshirt", journeyId: journey._id, companyId: co._id,
    materials: {
      status: "selected",
      rawItems: [
        { rawItemId: shell._id, rawItemName: shell.name, rawItemSku: shell.sku },
        { rawItemId: thread._id, rawItemName: thread.name, rawItemSku: thread.sku },
      ],
    },
    techSheet: { status: "pending" },
  });

  /* ── AND A MERCHANDISING SEAT ────────────────────────────────────────
     Most of this file is R&D's technical record, which is unchanged. A few
     cases here drive the MERCHANDISING doors that share this router — the
     packaging selection lifecycle and the development requirement — and those
     now prove a live `merchandiser` grant as well as a Sales session. Granted
     alongside, so the R&D cases are untouched and the Merchandising ones are
     exercised by somebody entitled to. */
  await DepartmentRole.create({
    departmentSlug: "merchandiser", email, name: "R", role: "owner", isActive: true,
    departmentId: new mongoose.Types.ObjectId(),
  });

  return {
    co, emp, style, shell, thread, n,
    user: { id: String(emp._id), email, name: "R", role: "sales" },
  };
}

async function master(n) {
  const [collar] = await Operation.create([
    { name: `Collar attach ${n}`, operationCode: `TR-COL-${n}`, totalSam: 0.64, durationSeconds: 38, machineType: "SNLS" },
  ]);
  return collar;
}

const FILE = { name: "techpack.pdf", url: "https://example.test/techpack.pdf" };

/** Start the sheet, fill everything, and return the ids used. */
async function completeRecord(w) {
  await call(`/${w.style._id}/tech-sheet`, { method: "POST", user: w.user, body: { action: "start" } });
  const op = await master(w.n);
  /* ── THE ROUTE IS NOT R&D'S TO WRITE ANY MORE ────────────────────────
     It is the Production Manager's, through its own door
     (services/production/styleRoute.service.js). These suites are about R&D's
     record, its revisions and what costing reads from it — so the route is
     seeded directly onto the document rather than through a boundary that no
     longer accepts it, and BEFORE the save, so the completeness the save
     reports is read against a routed style. The ownership itself is proved in
     test/costing/production-style-route.route.test.js. */
  await seedRoute(w, [{
    operationId: op._id, operationCode: op.operationCode, name: op.name,
    machineType: op.machineType, minutes: 0, seconds: 38, notes: "single needle",
  }]);
  const saved = await call(`/${w.style._id}/technical`, {
    method: "PUT", user: w.user,
    body: {
      materials: [
        { rawItemId: String(w.shell._id), specification: "220gsm single jersey", consumptionPerPiece: 0.28, unit: "kg", allowancePercent: 5, evidenceNote: "From marker" },
        { rawItemId: String(w.thread._id), specification: "40/2 poly", consumptionPerPiece: 120, unit: "m" },
      ],
      requirements: [{ family: "PACKAGING", name: "Poly bag", specification: "12x16 LDPE", quantity: 1, basis: "per garment", unit: "pcs", rationale: "Individual packing" }],
    },
  });
  return { op, saved };
}

/** Write a route the way Production's own boundary does — onto the record. */
async function seedRoute(w, operations) {
  await SampleStyle.updateOne(
    { _id: w.style._id },
    { $set: { "techSheet.technical.operations": operations } },
  );
}

/* ═══ 1 · MERCHANDISING SELECTS; IT DOES NOT MEASURE ══════════════════════ */

describe("the merchandiser's shortlist", () => {
  test("a new pick stores identity only — no consumption, no allowance", async () => {
    const w = await world();
    const r = await call(`/${w.style._id}/materials`, {
      method: "PATCH", user: w.user,
      body: {
        items: ["Shell fabric — Vendor A"],
        /* A client still sending a quantity: dropped, not stored, not
           refused — an older screen should still save its selection. */
        rawItems: [{ rawItemId: String(w.shell._id), rawItemName: w.shell.name, quantity: 0.2625, unit: "kg" }],
      },
    });
    expect(r.status).toBe(200);

    const after = await SampleStyle.findById(w.style._id).lean();
    const row = after.materials.rawItems[0];
    expect(String(row.rawItemId)).toBe(String(w.shell._id));
    /* The figure Merchandising was being asked for, and is not any more. */
    expect(row.quantity).toBeUndefined();
    expect(row.unit).toBeUndefined();
  });

  test("a pick with no quantity is accepted — it used to be refused outright", async () => {
    const w = await world();
    const r = await call(`/${w.style._id}/materials`, {
      method: "PATCH", user: w.user,
      body: { items: ["Shell"], rawItems: [{ rawItemId: String(w.shell._id), rawItemName: "Shell" }] },
    });
    expect(r.status).toBe(200);
    expect((await SampleStyle.findById(w.style._id).lean()).materials.rawItems).toHaveLength(1);
  });
});

/* ═══ 2 · R&D COMPLETES THE TECHNICAL FACTS ═══════════════════════════════ */

describe("R&D's technical record", () => {
  test("starting the tech sheet seeds a row per approved material, identity only", async () => {
    const w = await world();
    await call(`/${w.style._id}/tech-sheet`, { method: "POST", user: w.user, body: { action: "start" } });
    const r = await call(`/${w.style._id}/technical`, { user: w.user });

    expect(r.body.technical.status).toBe("draft");
    expect(r.body.technical.materials).toHaveLength(2);
    expect(r.body.technical.materials.map((m) => m.rawItemName).sort())
      .toEqual([w.shell.name, w.thread.name].sort());
    /* Seeded empty — nothing is guessed on R&D's behalf. */
    expect(r.body.technical.materials[0].consumptionPerPiece).toBeNull();
    expect(r.body.technical.materials[0].specification).toBe("");
  });

  test("R&D records consumption, unit, allowance and operations", async () => {
    const w = await world();
    const { op, saved } = await completeRecord(w);
    expect(saved.status).toBe(200);
    /* Everything R&D owns is now recorded. The only thing still outstanding
       is the supporting document, which is attached at submission — so the
       record is not "complete" yet, and the gap says exactly that rather
       than implying a missing technical fact. */
    expect(saved.body.completeness.gaps.map((g) => g.field)).toEqual(["file"]);

    const t = (await SampleStyle.findById(w.style._id).lean()).techSheet.technical;
    const shell = t.materials.find((m) => String(m.rawItemId) === String(w.shell._id));
    expect(shell.consumptionPerPiece).toBe(0.28);
    expect(shell.unit).toBe("kg");
    expect(shell.allowancePercent).toBe(5);
    expect(shell.specification).toBe("220gsm single jersey");

    /* The operation's identity and code come from the master, not the body. */
    expect(t.operations).toHaveLength(1);
    expect(t.operations[0].operationCode).toBe(op.operationCode);
    expect(svc.samMinutesOf(t.operations[0])).toBeCloseTo(0.633333, 5);
    /* And no rate is stored anywhere on it. */
    expect(JSON.stringify(t.operations[0])).not.toMatch(/salary|rate|cost/i);
  });

  test("an allowance nobody stated stays null, never zero", async () => {
    const w = await world();
    await completeRecord(w);
    const t = (await SampleStyle.findById(w.style._id).lean()).techSheet.technical;
    const thread = t.materials.find((m) => String(m.rawItemId) === String(w.thread._id));
    /* "Not said" and "said none" are different claims. */
    expect(thread.allowancePercent).toBeNull();
  });
});

/* ═══ 3 · WHAT IS MISSING IS NAMED, WITH ITS OWNER ════════════════════════ */

describe("blocking an incomplete record", () => {
  test("submission is refused and names the field AND the material", async () => {
    const w = await world();
    await call(`/${w.style._id}/tech-sheet`, { method: "POST", user: w.user, body: { action: "start" } });

    const r = await call(`/${w.style._id}/tech-sheet`, {
      method: "POST", user: w.user, body: { action: "submit", file: FILE },
    });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("TECHNICAL_RECORD_INCOMPLETE");

    const messages = r.body.gaps.map((g) => g.message);
    /* Never a generic "costing incomplete". */
    expect(messages.some((m) => /R&D still needs consumption per finished piece for/.test(m))).toBe(true);
    expect(messages.some((m) => m.includes(w.shell.name))).toBe(true);
    expect(messages.some((m) => /R&D still needs a consumption unit/.test(m))).toBe(true);
    expect(messages.some((m) => /R&D still needs a specification/.test(m))).toBe(true);
    expect(messages.some((m) => /operations this style is made through/.test(m))).toBe(true);
    /* And every one says whose desk it is. */
    expect(r.body.gaps.every((g) => g.owner)).toBe(true);
    expect(r.body.byOwner.RND.length).toBeGreaterThan(0);
  });

  test("a missing SAM blocks, naming the operation — and it is Production's gap", async () => {
    const w = await world();
    await call(`/${w.style._id}/tech-sheet`, { method: "POST", user: w.user, body: { action: "start" } });
    const op = await master(w.n);
    /* An untimed step on the record. Production owns the route now, so it is
       seeded the way Production's boundary writes it. */
    await seedRoute(w, [{
      operationId: op._id, operationCode: op.operationCode, name: op.name,
      machineType: op.machineType, minutes: 0, seconds: 0,
    }]);
    await call(`/${w.style._id}/technical`, {
      method: "PUT", user: w.user,
      body: {
        materials: [
          { rawItemId: String(w.shell._id), specification: "s", consumptionPerPiece: 1, unit: "kg" },
          { rawItemId: String(w.thread._id), specification: "s", consumptionPerPiece: 1, unit: "m" },
        ],

      },
    });
    const r = await call(`/${w.style._id}/tech-sheet`, {
      method: "POST", user: w.user, body: { action: "submit", file: FILE },
    });
    expect(r.status).toBe(400);
    const sam = r.body.gaps.find((g) => g.field === "sam" && g.message.includes(op.name));
    expect(sam).toBeTruthy();
    /* ── AND WHOSE GAP IT IS ─────────────────────────────────────────
       Production's. It used to be reported against R&D, who could see it,
       could not answer it, and had no way to say so. */
    expect(sam.owner).toBe("PRODUCTION");
    expect(sam.message).toMatch(/Production still needs a standard time/);
  });

  test("no attached document blocks the submission too", async () => {
    const w = await world();
    await completeRecord(w);
    const r = await call(`/${w.style._id}/tech-sheet`, {
      method: "POST", user: w.user, body: { action: "submit" },
    });
    expect(r.status).toBe(400);
    expect(r.body.gaps.some((g) => g.field === "file")).toBe(true);
  });
});

/* ═══ 4 · IDENTITY IS NOT R&D'S TO CHANGE ═════════════════════════════════ */

describe("material identity", () => {
  test("R&D cannot substitute another raw item", async () => {
    const w = await world();
    await call(`/${w.style._id}/tech-sheet`, { method: "POST", user: w.user, body: { action: "start" } });
    const other = await RawItem.create({ name: `Sneaky ${w.n}`, sku: `SNK-${w.n}`, createdBy: w.emp._id });

    const r = await call(`/${w.style._id}/technical`, {
      method: "PUT", user: w.user,
      body: { materials: [{ rawItemId: String(other._id), specification: "x", consumptionPerPiece: 9, unit: "kg" }] },
    });
    expect(r.status).toBe(200);

    const t = (await SampleStyle.findById(w.style._id).lean()).techSheet.technical;
    /* Still exactly the two approved materials, and the intruder is not one. */
    expect(t.materials).toHaveLength(2);
    expect(t.materials.map((m) => String(m.rawItemId))).not.toContain(String(other._id));
    /* Reported rather than dropped in silence. */
    expect(r.body.rejectedMaterials.map((x) => String(x.rawItemId))).toContain(String(other._id));
  });

  test("sending a material back to Materials REQUIRES a reason", async () => {
    const w = await world();
    await call(`/${w.style._id}/tech-sheet`, { method: "POST", user: w.user, body: { action: "start" } });
    const r = await call(`/${w.style._id}/technical/materials/return`, {
      method: "POST", user: w.user, body: { rawItemId: String(w.shell._id), reason: "  " },
    });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("RETURN_REASON_REQUIRED");
  });

  test("a returned material is recorded with actor and reason, and still listed", async () => {
    const w = await world();
    await call(`/${w.style._id}/tech-sheet`, { method: "POST", user: w.user, body: { action: "start" } });
    const r = await call(`/${w.style._id}/technical/materials/return`, {
      method: "POST", user: w.user, body: { rawItemId: String(w.shell._id), reason: "Wrong GSM — needs 220 not 180." },
    });
    expect(r.status).toBe(200);

    const after = await SampleStyle.findById(w.style._id).lean();
    const row = after.techSheet.technical.materials.find((m) => String(m.rawItemId) === String(w.shell._id));
    /* Kept, not deleted — the record shows what was questioned. */
    expect(row).toBeTruthy();
    expect(row.returnedToMaterials.reason).toMatch(/Wrong GSM/);
    expect(row.returnedToMaterials.by.name).toBe("R");
    expect(row.returnedToMaterials.at).toBeTruthy();
    /* And it is in the style's history. */
    expect(after.history.some((h) => h.kind === "material_returned")).toBe(true);
  });

  test("an ordinary row carries no empty return marker", async () => {
    /* Mongoose materialises an empty sub-object into `{ by: {} }`, which
       reads as a send-back to anything checking for the FIELD rather than
       for its reason. */
    const w = await world();
    await call(`/${w.style._id}/tech-sheet`, { method: "POST", user: w.user, body: { action: "start" } });
    await call(`/${w.style._id}/technical`, {
      method: "PUT", user: w.user,
      body: { materials: [{ rawItemId: String(w.shell._id), specification: "s", consumptionPerPiece: 1, unit: "kg" }] },
    });
    const row = (await SampleStyle.findById(w.style._id).lean())
      .techSheet.technical.materials.find((m) => String(m.rawItemId) === String(w.shell._id));
    expect(row.returnedToMaterials).toBeUndefined();
  });

  test("a returned material survives a later save", async () => {
    const w = await world();
    await call(`/${w.style._id}/tech-sheet`, { method: "POST", user: w.user, body: { action: "start" } });
    await call(`/${w.style._id}/technical/materials/return`, {
      method: "POST", user: w.user, body: { rawItemId: String(w.shell._id), reason: "Wrong GSM." },
    });
    await call(`/${w.style._id}/technical`, {
      method: "PUT", user: w.user,
      body: { materials: [{ rawItemId: String(w.shell._id), specification: "x", consumptionPerPiece: 1, unit: "kg" }] },
    });
    const row = (await SampleStyle.findById(w.style._id).lean())
      .techSheet.technical.materials.find((m) => String(m.rawItemId) === String(w.shell._id));
    /* A save is not a way to quietly withdraw a send-back. */
    expect(row.returnedToMaterials.reason).toMatch(/Wrong GSM/);
  });
});

/* ═══ 5 · SUBMISSION FREEZES; REWORK DOES NOT REWRITE HISTORY ═════════════ */

describe("revisions", () => {
  test("submitting freezes a snapshot with its file", async () => {
    const w = await world();
    await completeRecord(w);
    const r = await call(`/${w.style._id}/tech-sheet`, {
      method: "POST", user: w.user, body: { action: "submit", file: FILE },
    });
    expect(r.status).toBe(200);

    const after = await SampleStyle.findById(w.style._id).lean();
    expect(after.techSheet.technical.status).toBe("submitted");
    expect(after.techSheet.technical.revision).toBe(1);
    expect(after.techSheet.technicalRevisions).toHaveLength(1);

    const rev = after.techSheet.technicalRevisions[0];
    expect(rev.revision).toBe(1);
    expect(rev.outcome).toBe("submitted");
    expect(rev.file.name).toBe(FILE.name);
    expect(rev.snapshot.materials).toHaveLength(2);
    expect(rev.snapshot.materials.find((m) => m.rawItemName === w.shell.name).consumptionPerPiece).toBe(0.28);
    expect(rev.snapshot.operations[0].samMinutes).toBeCloseTo(0.633333, 5);
  });

  test("a submitted record is not editable by R&D", async () => {
    const w = await world();
    await completeRecord(w);
    await call(`/${w.style._id}/tech-sheet`, { method: "POST", user: w.user, body: { action: "submit", file: FILE } });
    const r = await call(`/${w.style._id}/technical`, {
      method: "PUT", user: w.user, body: { materials: [] },
    });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("TECHNICAL_RECORD_NOT_EDITABLE");
  });

  test("approval marks the revision, and Sales cannot alter a technical value", async () => {
    const w = await world();
    await completeRecord(w);
    await call(`/${w.style._id}/tech-sheet`, { method: "POST", user: w.user, body: { action: "submit", file: FILE } });

    /* An approver sending a different consumption alongside the decision. */
    const r = await call(`/${w.style._id}/tech-sheet`, {
      method: "POST", user: w.user,
      body: { action: "approve", materials: [{ rawItemId: String(w.shell._id), consumptionPerPiece: 99 }] },
    });
    expect(r.status).toBe(200);

    const after = await SampleStyle.findById(w.style._id).lean();
    expect(after.techSheet.technical.status).toBe("approved");
    expect(after.techSheet.technicalRevisions[0].outcome).toBe("approved");
    /* Not one value moved. */
    const shell = after.techSheet.technical.materials.find((m) => String(m.rawItemId) === String(w.shell._id));
    expect(shell.consumptionPerPiece).toBe(0.28);
    expect(after.techSheet.technicalRevisions[0].snapshot.materials
      .find((m) => m.rawItemName === w.shell.name).consumptionPerPiece).toBe(0.28);
  });

  test("Sales returning it reopens R&D, and the earlier snapshot is untouched", async () => {
    const w = await world();
    await completeRecord(w);
    await call(`/${w.style._id}/tech-sheet`, { method: "POST", user: w.user, body: { action: "submit", file: FILE } });
    await call(`/${w.style._id}/tech-sheet`, {
      method: "POST", user: w.user, body: { action: "changes", note: "Shell consumption looks high." },
    });

    let after = await SampleStyle.findById(w.style._id).lean();
    expect(after.techSheet.technical.status).toBe("rework");
    expect(after.techSheet.technicalRevisions[0].outcome).toBe("returned");
    expect(after.techSheet.technicalRevisions[0].decisionNote).toMatch(/looks high/);

    /* R&D revises. */
    await call(`/${w.style._id}/technical`, {
      method: "PUT", user: w.user,
      body: {
        materials: [
          { rawItemId: String(w.shell._id), specification: "220gsm", consumptionPerPiece: 0.24, unit: "kg", allowancePercent: 4 },
          { rawItemId: String(w.thread._id), specification: "40/2", consumptionPerPiece: 110, unit: "m" },
        ],

      },
    });

    after = await SampleStyle.findById(w.style._id).lean();
    /* The live record moved... */
    expect(after.techSheet.technical.materials
      .find((m) => String(m.rawItemId) === String(w.shell._id)).consumptionPerPiece).toBe(0.24);
    /* ...and revision 1 did NOT. */
    expect(after.techSheet.technicalRevisions[0].snapshot.materials
      .find((m) => m.rawItemName === w.shell.name).consumptionPerPiece).toBe(0.28);
    expect(after.techSheet.technicalRevisions).toHaveLength(1);
  });
});

/* ═══ 6 · WHAT THE COSTING READS ══════════════════════════════════════════ */

describe("the approved record is what costing reads", () => {
  const { readStyleFacts } = require("../../services/centralCosting/technicalSource.service");

  test("an unapproved record is named as the blocker, not reported as no materials", async () => {
    const w = await world();
    await completeRecord(w);
    const facts = await readStyleFacts({ companyId: w.co._id }, String(w.style._id));
    expect(facts.technicalRecord.usable).toBe(false);
    expect(facts.technicalRecord.blocker.owner).toBe("RND");
    expect(facts.technicalRecord.blocker.message).toMatch(/has not submitted an approved technical record/i);
    expect(facts.engineered).toHaveLength(0);
  });

  test("once approved, the engineered facts are what it costs from", async () => {
    const w = await world();
    await completeRecord(w);
    await call(`/${w.style._id}/tech-sheet`, { method: "POST", user: w.user, body: { action: "submit", file: FILE } });
    await call(`/${w.style._id}/tech-sheet`, { method: "POST", user: w.user, body: { action: "approve" } });

    const facts = await readStyleFacts({ companyId: w.co._id }, String(w.style._id));
    expect(facts.technicalRecord.usable).toBe(true);
    expect(facts.technicalRecord.approvedRevision).toBe(1);

    const shell = facts.engineered.find((e) => e.rawItemName === w.shell.name);
    expect(shell.evidence).toBe("RND_TECHNICAL_RECORD");
    expect(shell.quantity).toBe(0.28);
    expect(shell.unit).toBe("kg");
    /* The allowance is explicit and NOT already inside the quantity — the
       distinction the sample-measured row could never make. */
    expect(shell.allowancePercent).toBe(5);
    expect(shell.allowanceAlreadyInQuantity).toBe(false);
    expect(shell.importable).toBe(true);

    /* And the operations came from the approved record, with R&D's SAM. */
    expect(facts.operations).toHaveLength(1);
    expect(facts.operations[0].samMinutes).toBeCloseTo(0.633333, 5);
  });

  test("it reads the FROZEN revision, not a draft R&D is editing", async () => {
    const w = await world();
    await completeRecord(w);
    await call(`/${w.style._id}/tech-sheet`, { method: "POST", user: w.user, body: { action: "submit", file: FILE } });
    await call(`/${w.style._id}/tech-sheet`, { method: "POST", user: w.user, body: { action: "approve" } });

    /* Sales sends it back and R&D starts changing figures. A costing must go
       on reading what was approved. */
    await call(`/${w.style._id}/tech-sheet`, { method: "POST", user: w.user, body: { action: "changes", note: "again" } });
    await call(`/${w.style._id}/technical`, {
      method: "PUT", user: w.user,
      body: { materials: [{ rawItemId: String(w.shell._id), specification: "s", consumptionPerPiece: 0.99, unit: "kg" }] },
    });

    const facts = await readStyleFacts({ companyId: w.co._id }, String(w.style._id));
    const shell = facts.engineered.find((e) => e.rawItemName === w.shell.name);
    expect(shell.quantity).toBe(0.28);
  });

  test("a material sent back to Materials is not costable, and says why", async () => {
    const w = await world();
    await call(`/${w.style._id}/tech-sheet`, { method: "POST", user: w.user, body: { action: "start" } });
    await call(`/${w.style._id}/technical/materials/return`, {
      method: "POST", user: w.user, body: { rawItemId: String(w.shell._id), reason: "Wrong GSM." },
    });
    const row = svc.snapshotOf({
      materials: [{ rawItemId: w.shell._id, rawItemName: w.shell.name, returnedToMaterials: { reason: "Wrong GSM." } }],
    }).materials[0];
    expect(row.returnedToMaterials.reason).toBe("Wrong GSM.");
  });
});

/* ═══ 7 · TENANCY AND VISIBILITY ══════════════════════════════════════════ */

describe("isolation", () => {
  test("another company's style answers nothing at all", async () => {
    const mine = await world();
    const theirs = await world();
    for (const [path, opts] of [
      [`/${theirs.style._id}/technical`, { user: mine.user }],
      [`/${theirs.style._id}/technical`, { method: "PUT", user: mine.user, body: { materials: [] } }],
      [`/${theirs.style._id}/technical/materials/return`, { method: "POST", user: mine.user, body: { rawItemId: String(theirs.shell._id), reason: "x" } }],
    ]) {
      const r = await call(path, opts);
      /* Missing and foreign are one answer. */
      expect(r.status).toBe(404);
    }
  });

  test("the record carries no cost, rate or policy figure anywhere", async () => {
    const w = await world();
    await completeRecord(w);
    const r = await call(`/${w.style._id}/technical`, { user: w.user });
    const body = JSON.stringify(r.body);
    /* R&D records time and quantity; money is nobody's business on this
       screen, and Store's rates are not on it either. */
    expect(body).not.toMatch(/operatorSalary|operatorCost|ratePercent|unitRate|amountMinor/);
  });
});

/* ═══ 8 · THE SHORTLIST COMES FROM THE FINISHED GOOD'S BOM ════════════════ */

describe("where the approved materials come from", () => {
  /**
   * The live shape of the demo polo: a linked finished good whose variants
   * carry the approved BOM, and `style.materials.rawItems` EMPTY — the field
   * only the retired materials-picking form ever wrote.
   */
  async function withFinishedGood({ legacyPick = [] } = {}) {
    const w = await world();
    const polo = await RawItem.create({ name: `POLO 150 ${w.n}`, sku: `POLO-${w.n}`, createdBy: w.emp._id });
    const product = await StockItem.create({
      name: "DEMO Navy Cotton Polo", reference: `PROD-POLO-${w.n}`, category: "Shirt",
      operations: [], createdBy: w.emp._id,
      variants: [
        {
          sku: `POLO-${w.n}-S`, attributes: [{ name: "Size", value: "S" }],
          quantity: 0, cost: 0, salesPrice: 0,
          rawItems: [{
            rawItemId: polo._id, rawItemName: polo.name, rawItemSku: polo.sku,
            variantCombination: ["Navy"],
            /* Figures that must NOT cross into R&D's fields. */
            quantity: 0.2625, unit: "kg", allowancePercent: 5, unitCost: 410, totalCost: 107.6,
          }],
        },
        {
          sku: `POLO-${w.n}-M`, attributes: [{ name: "Size", value: "M" }],
          quantity: 0, cost: 0, salesPrice: 0,
          rawItems: [{
            rawItemId: polo._id, rawItemName: polo.name, rawItemSku: polo.sku,
            variantCombination: ["Navy"],
            quantity: 0.2800, unit: "kg", allowancePercent: 5, unitCost: 410, totalCost: 114.8,
          }],
        },
      ],
    });
    /* Empty, exactly as every style raised since the picking form was
       retired. */
    await SampleStyle.updateOne({ _id: w.style._id }, {
      $set: { "materials.rawItems": legacyPick, "production.stockItemId": product._id },
    });
    return { ...w, polo, product };
  }

  test("an empty materials.rawItems still seeds from the finished good's BOM", async () => {
    const w = await withFinishedGood();
    await call(`/${w.style._id}/tech-sheet`, { method: "POST", user: w.user, body: { action: "start" } });
    const r = await call(`/${w.style._id}/technical`, { user: w.user });

    expect(r.body.shortlistSource).toBe("FINISHED_GOOD_BOM");
    expect(r.body.shortlistBlocker).toBeNull();
    /* One row: de-duped across the two sizes, exactly as the visible panel
       shows it. */
    expect(r.body.technical.materials).toHaveLength(1);
    expect(r.body.technical.materials[0].rawItemName).toBe(w.polo.name);
    expect(r.body.technical.materials[0].rawItemSku).toBe(w.polo.sku);
  });

  test("the technical-record count EQUALS the visible BOM panel's count", async () => {
    const w = await withFinishedGood();
    /* What the R&D page's Approved BOM panel renders. */
    const product = await StockItem.findById(w.product._id).lean();
    const visible = stockItemBom(product);

    await call(`/${w.style._id}/tech-sheet`, { method: "POST", user: w.user, body: { action: "start" } });
    const r = await call(`/${w.style._id}/technical`, { user: w.user });

    expect(visible.length).toBe(1);
    expect(r.body.technical.materials.length).toBe(visible.length);
    expect(r.body.technical.materials.map((m) => m.rawItemName).sort())
      .toEqual(visible.map((v) => v.rawItemName).sort());
  });

  test("NO BOM quantity, allowance, unit or rate reaches R&D's fields", async () => {
    const w = await withFinishedGood();
    await call(`/${w.style._id}/tech-sheet`, { method: "POST", user: w.user, body: { action: "start" } });
    const row = (await call(`/${w.style._id}/technical`, { user: w.user })).body.technical.materials[0];

    /* The BOM says 0.2625 kg + 5% at ₹410. None of it is an R&D fact: it is
       what a previous product was built with, and presenting it as this
       style's engineered consumption is the mistake this record exists to
       correct. */
    expect(row.consumptionPerPiece).toBeNull();
    expect(row.unit).toBe("");
    expect(row.allowancePercent).toBeNull();
    expect(row.specification).toBe("");
    expect(JSON.stringify(row)).not.toMatch(/0\.2625|unitCost|totalCost|410/);

    /* And it is still reported as incomplete, naming R&D — the facts really
       are missing, they were simply never Merchandising's to supply. */
    const gaps = (await call(`/${w.style._id}/technical`, { user: w.user })).body.completeness.gaps;
    expect(gaps.some((g) => g.owner === "RND" && /consumption per finished piece/.test(g.message))).toBe(true);
  });

  test("GET, save, completeness and return-to-materials all read the same source", async () => {
    const w = await withFinishedGood();
    await call(`/${w.style._id}/tech-sheet`, { method: "POST", user: w.user, body: { action: "start" } });
    const id = String(w.polo._id);

    /* GET */
    const got = await call(`/${w.style._id}/technical`, { user: w.user });
    expect(got.body.technical.materials.map((m) => String(m.rawItemId))).toEqual([id]);

    /* SAVE — the row is accepted because the shortlist holds it. */
    const saved = await call(`/${w.style._id}/technical`, {
      method: "PUT", user: w.user,
      body: { materials: [{ rawItemId: id, specification: "150gsm pique", consumptionPerPiece: 0.3, unit: "kg" }] },
    });
    expect(saved.body.shortlistSource).toBe("FINISHED_GOOD_BOM");
    expect(saved.body.technical.materials).toHaveLength(1);
    expect(saved.body.technical.materials[0].consumptionPerPiece).toBe(0.3);
    expect(saved.body.rejectedMaterials).toEqual([]);

    /* COMPLETENESS — counts against the same one material, and every
       remaining gap is something genuinely not yet recorded (this fixture
       has no operations and no file), never the material itself. */
    expect(saved.body.completeness.counts.materials).toBe(1);
    expect(saved.body.completeness.gaps.map((g) => g.field).sort()).toEqual(["file", "operations"]);
    expect(saved.body.completeness.gaps.some((g) => g.field === "materials")).toBe(false);

    /* RETURN-TO-MATERIALS — accepted for a shortlist material... */
    const back = await call(`/${w.style._id}/technical/materials/return`, {
      method: "POST", user: w.user, body: { rawItemId: id, reason: "Wrong GSM." },
    });
    expect(back.status).toBe(200);

    /* ...and refused for one the approved BOM does not hold. */
    const other = await RawItem.create({ name: `Elsewhere ${w.n}`, sku: `ELS-${w.n}`, createdBy: w.emp._id });
    const nope = await call(`/${w.style._id}/technical/materials/return`, {
      method: "POST", user: w.user, body: { rawItemId: String(other._id), reason: "x" },
    });
    expect(nope.status).toBe(404);
    expect(nope.body.message).toMatch(/approved bill of materials/i);
  });

  test("a legacy style with no finished good falls back, explicitly", async () => {
    /* Styles raised before the picking form was retired have `rawItems` and
       no finished good. It is the only record of what was selected for them,
       so it is kept — and named, so a reader can tell it apart. */
    const w = await world();   // world() sets materials.rawItems and no stockItem
    const shortlist = await approvedShortlistFor(await SampleStyle.findById(w.style._id).lean());
    expect(shortlist.source).toBe("LEGACY_STYLE_PICK");
    expect(shortlist.rows).toHaveLength(2);
    expect(shortlist.blocker).toBeNull();

    await call(`/${w.style._id}/tech-sheet`, { method: "POST", user: w.user, body: { action: "start" } });
    const r = await call(`/${w.style._id}/technical`, { user: w.user });
    expect(r.body.shortlistSource).toBe("LEGACY_STYLE_PICK");
    expect(r.body.technical.materials).toHaveLength(2);
  });

  test("the finished good WINS over a legacy pick — the screen shows the BOM", async () => {
    const w = await withFinishedGood({
      legacyPick: [{ rawItemId: new mongoose.Types.ObjectId(), rawItemName: "Stale hand-typed row" }],
    });
    const shortlist = await approvedShortlistFor(await SampleStyle.findById(w.style._id).lean());
    expect(shortlist.source).toBe("FINISHED_GOOD_BOM");
    expect(shortlist.rows.map((r) => r.rawItemName)).toEqual([w.polo.name]);
  });

  test("no approved shortlist anywhere blames MERCHANDISING, not R&D", async () => {
    const w = await world();
    await SampleStyle.updateOne({ _id: w.style._id }, { $set: { "materials.rawItems": [] } });

    const r = await call(`/${w.style._id}/technical`, { user: w.user });
    expect(r.body.shortlistSource).toBe("NONE");
    expect(r.body.shortlistBlocker.owner).toBe("MERCHANDISING");
    expect(r.body.shortlistBlocker.message).toMatch(/Merchandising selects the materials/i);

    /* And the completeness gate reports the SAME owner rather than an R&D
       gap against a form with nothing in it. */
    const materialsGap = r.body.completeness.gaps.find((g) => g.field === "materials");
    expect(materialsGap.owner).toBe("MERCHANDISING");
  });
});

/* ═══ 9 · PACKAGING HAS EXACTLY ONE WRITABLE HOME ═════════════════════════
 *
 * The generic requirements list briefly accepted `family: "PACKAGING"`. That
 * gave one fact two writable homes, and only the OTHER one was ever read —
 * `sample.packagingRequirements` is what the costing assembles from. A row
 * recorded through the generic field would have been invisible to every
 * costing that needed it.
 */
describe("packaging is not a generic requirement", () => {
  test("the family is refused on save", async () => {
    const w = await world();
    await call(`/${w.style._id}/tech-sheet`, { method: "POST", user: w.user, body: { action: "start" } });
    const r = await call(`/${w.style._id}/technical`, {
      method: "PUT", user: w.user,
      body: {
        requirements: [
          { family: "PACKAGING", name: "Poly bag", specification: "300x400", quantity: 1, basis: "per garment", unit: "pcs", rationale: "packing" },
          { family: "SERVICE", name: "Enzyme wash", specification: "two cycles", quantity: 1, basis: "per garment", unit: "pcs", rationale: "handfeel" },
        ],
      },
    });
    expect(r.status).toBe(200);
    /* The service row survives; the packaging row is not stored here. */
    expect(r.body.technical.requirements.map((x) => x.family)).toEqual(["SERVICE"]);
  });

  test("the two families it does accept are unaffected", () => {
    expect([...svc.REQUIREMENT_FAMILIES]).toEqual(["SERVICE", "DEVELOPMENT_TOOLING"]);
    expect([...svc.RETIRED_FAMILIES]).toEqual(["PACKAGING"]);
  });

  test("a row stored under the retired family is REPORTED, never dropped", async () => {
    /* Compatibility, not cleanup. A style written while the value was
       accepted keeps its row, and the screen is told where the fact now
       belongs rather than the row silently vanishing from a form that no
       longer offers its family. */
    const legacy = svc.retiredPackagingRequirements({
      requirements: [
        { family: "PACKAGING", name: "Hang tag" },
        { family: "SERVICE", name: "Enzyme wash" },
      ],
    });
    expect(legacy).toHaveLength(1);
    expect(legacy[0]).toMatchObject({ name: "Hang tag", family: "PACKAGING", owner: "RND" });
    expect(legacy[0].message).toMatch(/Record it under Packaging on the technical record/);
  });

  test("the style schema itself refuses the retired family", async () => {
    /* Refused at the schema rather than merely unused, so the mistake cannot
       be reintroduced by a different write path. */
    const path = SampleStyle.schema.path("techSheet.technical.requirements");
    const family = path.schema.path("family");
    expect(family.enumValues).toEqual(["SERVICE", "DEVELOPMENT_TOOLING"]);
  });
});

/* ═══ 10 · MERCHANDISING SELECTS PACKAGING; IT DOES NOT MEASURE IT ════════
 *
 * Which components the style needs — poly bag, hang tag, carton. How many of
 * each is confirmed after sampling and is R&D's, in
 * `sample.packagingRequirements`. One record holding both is how a figure
 * nobody measured ends up presented as a fact.
 */
describe("the merchandising packaging selection", () => {
  const RawItemModel = require("../../models/CMS_Models/Inventory/Products/RawItem");

  async function polyBag(w) {
    return RawItemModel.create({
      companyId: w.co._id, name: `Poly bag ${w.n}`, sku: `PKG-${w.n}`,
      unit: "Piece", quantity: 0, minStock: 0, maxStock: 10, variants: [],
    });
  }

  test("a component is chosen by identity, with a packing instruction", async () => {
    const w = await world();
    const bag = await polyBag(w);
    const r = await call(`/${w.style._id}/packaging-selections`, {
      method: "POST", user: w.user,
      body: { rawItemId: String(bag._id), specification: "Printed poly bag, 300x400mm" },
    });
    expect(r.status).toBe(201);
    expect(r.body.selection).toMatchObject({
      rawItemName: bag.name, rawItemSku: bag.sku,
      specification: "Printed poly bag, 300x400mm", status: "proposed",
    });
    expect(r.body.selection.rowId).toBeTruthy();
  });

  test("it stores NO quantity, rate, supplier or carton capacity", async () => {
    const w = await world();
    const bag = await polyBag(w);
    /* A client sending all four: none of them is Merchandising's to state,
       and the carton count is a shipment fact stated once for the style. */
    await call(`/${w.style._id}/packaging-selections`, {
      method: "POST", user: w.user,
      body: {
        rawItemId: String(bag._id), specification: "spec",
        quantity: 1, unit: "Piece", rate: 250, supplierId: String(w.emp._id),
        basis: "PER_CARTON", garmentsPerCarton: 25,
      },
    });
    const stored = (await SampleStyle.findById(w.style._id).lean()).materials.packagingSelections[0];
    for (const banned of ["quantity", "unit", "rate", "supplierId", "basis", "garmentsPerCarton"]) {
      expect(stored[banned]).toBeUndefined();
    }
    /* And nothing money-shaped leaves on the SELECTION either. The response
       also carries the style's shipment carton count — R&D's own fact, shared
       with freight, reported so a carton row can show what it depends on —
       so the check is against the selection data rather than the envelope. */
    const list = await call(`/${w.style._id}/packaging-selections`, { user: w.user });
    expect(JSON.stringify(list.body.selections)).not.toMatch(/quantity|rate|supplier|carton|price/i);
    /* A rate or a supplier must appear nowhere in the response at all. */
    expect(JSON.stringify(list.body)).not.toMatch(/rate|supplier|price|amountMinor/i);
  });

  test("an item from another company is refused, and says nothing about it", async () => {
    const mine = await world();
    const theirs = await world();
    const foreign = await polyBag(theirs);
    const r = await call(`/${mine.style._id}/packaging-selections`, {
      method: "POST", user: mine.user, body: { rawItemId: String(foreign._id) },
    });
    expect(r.status).toBe(404);
    expect(r.body.code).toBe("PACKAGING_ITEM_NOT_FOUND");
    /* Nothing about the other company's item leaks into the refusal. */
    expect(JSON.stringify(r.body)).not.toMatch(new RegExp(foreign.name));
  });

  test("another company's style answers nothing at all", async () => {
    const mine = await world();
    const theirs = await world();
    for (const [path, opts] of [
      [`/${theirs.style._id}/packaging-selections`, { user: mine.user }],
      [`/${theirs.style._id}/packaging-selections`, { method: "POST", user: mine.user, body: { rawItemId: String((await polyBag(mine))._id) } }],
    ]) {
      expect((await call(path, opts)).status).toBe(404);
    }
  });

  test("withdrawing a component REQUIRES a reason", async () => {
    /* R&D may already have recorded consumption against it, and "it went
       away" is not something they can act on. */
    const w = await world();
    const bag = await polyBag(w);
    const added = await call(`/${w.style._id}/packaging-selections`, {
      method: "POST", user: w.user, body: { rawItemId: String(bag._id) },
    });
    const rowId = added.body.selection.rowId;

    const bad = await call(`/${w.style._id}/packaging-selections/${rowId}`, {
      method: "PATCH", user: w.user, body: { status: "withdrawn" },
    });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe("PACKAGING_WITHDRAW_REASON_REQUIRED");

    const ok = await call(`/${w.style._id}/packaging-selections/${rowId}`, {
      method: "PATCH", user: w.user, body: { status: "withdrawn", withdrawnReason: "Customer supplies bags." },
    });
    expect(ok.status).toBe(200);
    /* Withdrawn, never deleted — the decision stays explicable. */
    const stored = (await SampleStyle.findById(w.style._id).lean()).materials.packagingSelections;
    expect(stored).toHaveLength(1);
    expect(stored[0].status).toBe("withdrawn");
    expect(stored[0].withdrawnReason).toBe("Customer supplies bags.");
    expect(stored[0].withdrawnBy.name).toBe("R");
  });

  test("approving one records the actor and leaves the identity alone", async () => {
    const w = await world();
    const bag = await polyBag(w);
    const added = await call(`/${w.style._id}/packaging-selections`, {
      method: "POST", user: w.user, body: { rawItemId: String(bag._id) },
    });
    const r = await call(`/${w.style._id}/packaging-selections/${added.body.selection.rowId}`, {
      method: "PATCH", user: w.user, body: { status: "approved" },
    });
    expect(r.status).toBe(200);
    expect(r.body.selection.status).toBe("approved");
    expect(r.body.selection.rawItemId).toBe(String(bag._id));
  });

  test("two rows may name the same item — they are two components", async () => {
    /* Two different printed bags. Keyed by what they name they would be one. */
    const w = await world();
    const bag = await polyBag(w);
    const a = await call(`/${w.style._id}/packaging-selections`, {
      method: "POST", user: w.user, body: { rawItemId: String(bag._id), specification: "Inner bag" },
    });
    const b = await call(`/${w.style._id}/packaging-selections`, {
      method: "POST", user: w.user, body: { rawItemId: String(bag._id), specification: "Outer bag" },
    });
    expect(a.body.selection.rowId).not.toBe(b.body.selection.rowId);
    expect((await SampleStyle.findById(w.style._id).lean()).materials.packagingSelections).toHaveLength(2);
  });
});

/* ═══ 11 · THE MERCHANDISING STYLE BOUNDARY ═══════════════════════════════
 *
 * Merchandising works from a STYLE and has no Journey concept at all. The
 * ordinary style list populates `journeyId` and returns the journey's name,
 * which is Sales' commercial spine — so this is a separate, deliberately thin
 * boundary that publishes identity and nothing else.
 */
describe("the merchandising style boundary", () => {
  const RawItemModel = require("../../models/CMS_Models/Inventory/Products/RawItem");

  test("it lists this company's styles, by identity only", async () => {
    const w = await world();
    const r = await call("/merchandising/styles", { user: w.user });
    expect(r.status).toBe(200);

    const mine = r.body.styles.find((x) => x.id === String(w.style._id));
    expect(mine).toMatchObject({ styleRef: w.style.sampleStyleId, productName: "Soumya Tshirt" });
    expect(mine.packagingCounts).toMatchObject({ approved: 0, proposed: 0, withdrawn: 0 });
  });

  test("NO journey, enquiry, customer or commercial field is published", async () => {
    const w = await world();
    const list = await call("/merchandising/styles", { user: w.user });
    const one = await call(`/merchandising/styles/${w.style._id}`, { user: w.user });

    for (const body of [list.body, one.body]) {
      const text = JSON.stringify(body);
      /* `ownershipProofFor` returns `journeyRef` and it is deliberately not
         read here — publishing the proof would put the journey back on the
         screen through the back door. */
      for (const banned of [/journey/i, /enquiry/i, /customer/i, /quotation/i, /supplier/i, /\brate\b/i, /\bprice\b/i, /amountMinor/i, /margin/i, /costing/i]) {
        expect(text).not.toMatch(banned);
      }
    }
  });

  test("another company's styles are absent, and its style answers nothing", async () => {
    const mine = await world();
    const theirs = await world();

    const list = await call("/merchandising/styles", { user: mine.user });
    expect(list.body.styles.map((s) => s.id)).not.toContain(String(theirs.style._id));
    expect(list.body.styles.map((s) => s.id)).toContain(String(mine.style._id));

    /* Missing and foreign are one answer. */
    expect((await call(`/merchandising/styles/${theirs.style._id}`, { user: mine.user })).status).toBe(404);
  });

  test("an unauthenticated caller gets nothing", async () => {
    const w = await world();
    expect((await call("/merchandising/styles")).status).toBe(401);
    expect((await call(`/merchandising/styles/${w.style._id}`)).status).toBe(401);
  });

  test("the packaging lifecycle is counted, so the list can show where a style stands", async () => {
    const w = await world();
    const bag = await RawItemModel.create({
      companyId: w.co._id, name: `Poly bag ${w.n}`, sku: `PKG-L-${w.n}`,
      unit: "Piece", quantity: 0, minStock: 0, maxStock: 10, variants: [],
    });
    const added = await call(`/${w.style._id}/packaging-selections`, {
      method: "POST", user: w.user, body: { rawItemId: String(bag._id) },
    });
    await call(`/${w.style._id}/packaging-selections/${added.body.selection.rowId}`, {
      method: "PATCH", user: w.user, body: { status: "approved" },
    });

    const one = await call(`/merchandising/styles/${w.style._id}`, { user: w.user });
    expect(one.body.style.packagingCounts).toMatchObject({ approved: 1, proposed: 0, withdrawn: 0 });
    /* And still no component detail, supplier or figure on this boundary. */
    expect(JSON.stringify(one.body)).not.toMatch(/rawItemName|quantity|unit/i);
  });

  test("the packaging handoff gives Merchandising a safe R&D status, not R&D's technical record", async () => {
    const w = await world();
    const bag = await RawItemModel.create({
      companyId: w.co._id, name: `Poly bag handoff ${w.n}`, sku: `PKG-H-${w.n}`,
      unit: "Piece", quantity: 0, minStock: 0, maxStock: 10, variants: [],
    });
    const added = await call(`/${w.style._id}/packaging-selections`, {
      method: "POST", user: w.user, body: { rawItemId: String(bag._id), specification: "Inner bag" },
    });
    const rowId = added.body.selection.rowId;
    await call(`/${w.style._id}/packaging-selections/${rowId}`, {
      method: "PATCH", user: w.user, body: { status: "approved" },
    });
    await call(`/${w.style._id}/packaging-requirements/${rowId}`, {
      method: "PATCH", user: w.user,
      body: { quantity: 2, unit: "Piece", basis: "PER_GARMENT", evidence: "SAMPLE_MEASURED", notes: "Measured after wash." },
    });

    const handoff = await call(`/merchandising/styles/${w.style._id}/packaging`, { user: w.user });
    expect(handoff.status).toBe(200);
    expect(handoff.body.selections).toHaveLength(1);
    expect(handoff.body.selections[0]).toMatchObject({
      rowId, status: "approved",
      handoff: { state: "RND_CONSUMPTION_RECORDED", label: "R&D consumption recorded" },
    });
    /* The status is useful to Merchandising, but no R&D measurement, unit,
       evidence, note, exclusion reason or shipment detail crosses back. */
    expect(JSON.stringify(handoff.body)).not.toMatch(/quantity|unit|evidence|notes|excludedReason|carton|SAMPLE_MEASURED/i);

    await call(`/${w.style._id}/packaging-selections/${rowId}`, {
      method: "PATCH", user: w.user, body: { status: "withdrawn", withdrawnReason: "Customer supplies bags." },
    });
    const withdrawn = await call(`/merchandising/styles/${w.style._id}/packaging`, { user: w.user });
    expect(withdrawn.body.selections[0].handoff).toEqual({
      state: "WITHDRAWN_WITH_RND_RECORD", label: "Withdrawn — R&D record retained",
    });
  });
});

/* ══ A STALE MATERIAL SELECTION BLOCKS THE SUBMISSION ══════════════════════

   Most shortlist blockers answer "why is there nothing to work on?", so they
   only matter when the form is empty. A STALE one is different: the record can
   be complete and perfectly good and still describe materials that have been
   replaced since Sales released them. Submitting it would record engineering
   against a selection nobody is going to use, and the person doing it would
   have no way to know. */

describe("a superseded material selection is refused whatever the form holds", () => {
  const technicalRecord = require("../../services/centralCosting/technicalRecord.service");

  const STALE = Object.freeze({
    owner: "SALES",
    field: "materials",
    code: "DEVELOPMENT_MATERIALS_STALE",
    releasedBomRevisionNo: 1,
    currentBomRevisionNo: 2,
    message: "Development MDV-2026-0001 revision 2 has been approved by Merchandising, replacing "
      + "revision 1, which is the one released to R&D. Sales reviews and releases the new revision "
      + "before any further technical work is recorded against these materials.",
  });

  const full = () => ({
    materials: [{
      name: "Pique 180gsm", consumption: 1.4, unit: "m", allowance: 5,
      status: "completed",
    }],
    operations: [{ name: "Attach collar", sam: 1.2 }],
    requirements: [],
  });

  test("a complete record is still refused while the selection is stale", () => {
    const clean = technicalRecord.completeness(full(), { shortlistBlocker: null });
    const blocked = technicalRecord.completeness(full(), { shortlistBlocker: STALE });

    /* The ONLY difference is the stale blocker — the record itself is the
       same, which is the point. */
    expect(blocked.complete).toBe(false);
    expect(blocked.gaps.some((g) => g.code === "DEVELOPMENT_MATERIALS_STALE")).toBe(true);
    expect(clean.gaps.some((g) => g.code === "DEVELOPMENT_MATERIALS_STALE")).toBe(false);
  });

  test("the outstanding step is named as SALES, not as an R&D omission", () => {
    const gate = technicalRecord.completeness(full(), { shortlistBlocker: STALE });
    const stale = gate.gaps.find((g) => g.code === "DEVELOPMENT_MATERIALS_STALE");
    expect(stale.owner).toBe("SALES");
    expect(stale.releasedBomRevisionNo).toBe(1);
    expect(stale.currentBomRevisionNo).toBe(2);
    /* Telling R&D their own record is incomplete would send them looking for
       work that is not theirs. */
    expect(stale.message).toMatch(/Sales reviews and releases/);
  });

  test("an empty record reports BOTH the stale selection and the empty form", () => {
    /* They are two different true things, and collapsing them would hide
       whichever one was reported second. */
    const gate = technicalRecord.completeness(
      { materials: [], operations: [], requirements: [] },
      { shortlistBlocker: STALE },
    );
    const materialGaps = gate.gaps.filter((g) => g.field === "materials");
    expect(materialGaps.some((g) => g.code === "DEVELOPMENT_MATERIALS_STALE")).toBe(true);
    expect(materialGaps.some((g) => g.owner === "RND")).toBe(true);
  });

  test("an ordinary shortlist blocker still behaves as it did", () => {
    /* The nobody-has-selected-anything blocker replaces the empty-form gap
       rather than joining it: there is one outstanding step, and it is
       Merchandising's. */
    const ordinary = { owner: "MERCHANDISING", field: "materials", message: "Nobody has selected materials." };
    const gate = technicalRecord.completeness(
      { materials: [], operations: [], requirements: [] },
      { shortlistBlocker: ordinary },
    );
    const materialGaps = gate.gaps.filter((g) => g.field === "materials");
    expect(materialGaps).toHaveLength(1);
    expect(materialGaps[0].owner).toBe("MERCHANDISING");
  });
});

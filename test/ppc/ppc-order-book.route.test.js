// test/ppc/ppc-order-book.route.test.js
//
// PPC LANE A — THE ORDER BOOK AND THE PLANNING FILE, AT THE WIRE.
//
// The claims worth holding:
//
//   · a confirmed order line is in the book even with NOTHING attached, and its
//     missing inputs are stated as missing rather than hidden by a filter;
//   · a FAILED source read says "Couldn’t check" and never "Not received",
//     never zero, and never ready;
//   · only the exact accepted pack, the exact accepted release and issued
//     minutes make a line ready to plan — and Store's status never does;
//   · a planning file is identified by the PERMANENT line reference, so two
//     colourways with one name and two lines of one style stay separate;
//   · one active planning file per line, decided at the index, so concurrent
//     creation produces ONE record;
//   · every upstream identity is server-derived, and a forged one is refused
//     BY NAME rather than ignored;
//   · the frozen basis is immutable, movement is detected, and a successor
//     preserves its predecessor entirely;
//   · company isolation, the viewer/editor/approver ladder, stale-revision
//     conflicts and exact idempotent replay;
//   · and nothing here books capacity, allocates a line, or writes Production,
//     Store, Merchandising or IE.
"use strict";
process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const fs = require("fs");
const path = require("path");
const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const Employee = require("../../models/Employee");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const DeptUser = require("../../models/Access/DeptUser");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");

const ExecutionFile = require("../../models/CMS_Models/Merchandising/ExecutionFile");
const { ExecutionPack } = require("../../models/CMS_Models/Merchandising/ExecutionPack");
const {
  PreProductionMeeting,
} = require("../../models/CMS_Models/Merchandising/PreProductionMeeting");
const {
  DepartmentStatusProjection,
} = require("../../models/CMS_Models/Merchandising/DepartmentStatusProjection");
const {
  DownstreamHandoverReceipt,
} = require("../../models/CMS_Models/PPC/DownstreamHandoverReceipt");
const { IeReleaseReceipt } = require("../../models/CMS_Models/PPC/IeReleaseReceipt");
const IeRelease = require("../../models/CMS_Models/IndustrialEngineering/IeRelease");
const {
  PpcPlanningFile, PLANNING_STATE,
} = require("../../models/CMS_Models/PPC/PpcPlanningFile");

let server, ppcBase, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/cms/ppc", require("../../routes/CMS_Routes/PPC/orderBookRoute"));
  await new Promise((r) => { server = app.listen(0, r); });
  ppcBase = `http://127.0.0.1:${server.address().port}/api/cms/ppc`;
  await PpcPlanningFile.syncIndexes();
  await ExecutionFile.syncIndexes();
  await IeReleaseReceipt.syncIndexes();
});

afterAll(async () => { await new Promise((r) => server.close(r)); });

const ppc = (p, { method = "GET", body, token, company, key } = {}) =>
  fetch(`${ppcBase}${p}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(company ? { "X-Costing-Company": String(company) } : {}),
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => {
    const text = await r.text();
    let parsed = null;
    try { parsed = JSON.parse(text || "null"); } catch { parsed = { nonJson: true }; }
    return { status: r.status, body: parsed };
  });

let keySeq = 0;
const nextKey = () => `ppc-plan-${++keySeq}-${Date.now()}`;

/* ══ ACTORS ═══════════════════════════════════════════════════════════════ */

async function actor({ companies = [], grants = {} } = {}) {
  const n = ++seq;
  const email = `pl${n}@grav.test`;
  const emp = await Employee.create({
    firstName: "P", lastName: `P${n}`, email, biometricId: `PLN${n}`,
    isActive: true, gender: "Other", department: "Tech",
  });
  await DeptUser.create({
    name: "User", email, passwordHash: "x", isAdmin: false, isActive: true,
    departmentId: new mongoose.Types.ObjectId(), employeeRef: emp._id,
  });
  for (const co of companies) {
    await SpCompanyMembership.create({
      companyId: co._id, email, employeeRef: emp._id, personName: "P",
    });
  }
  for (const [departmentSlug, role] of Object.entries(grants)) {
    await DepartmentRole.create({
      departmentSlug, email, name: "User", role, isActive: true,
      departmentId: new mongoose.Types.ObjectId(),
    });
  }
  const name = `Planner ${n}`;
  return {
    email, name, employeeId: String(emp._id),
    token: jwt.sign(
      { id: String(emp._id), email, name, role: "employee", employeeId: emp.biometricId },
      process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" },
    ),
  };
}

const company = async (label) => Acc_Company.create({
  companyName: `${label} ${++seq}`, booksFromDate: new Date("2026-04-01"),
});

/* ══ THE FROZEN INPUTS ════════════════════════════════════════════════════
   Seeded as records rather than driven through their own applications' routes.
   These are this slice's FROZEN INPUTS — Merchandising's pack, the issued
   minutes, IE's release and PPC's receipts are accepted, tested applications,
   and re-driving their whole approval chains here would test them again rather
   than testing the order book that reads them. What is under test is the
   READING: the join, the verdicts, the honesty of a failed read. */

/**
 * One confirmed order line.
 *
 * `lineRef` is the PERMANENT reference and the only thing anything joins on.
 * `styleName` and `colourway` are deliberately reusable across lines, because
 * proving they are never joined on requires two lines that share them.
 */
async function orderLine(co, {
  lineRef, orderRef = "ORD-1", styleName = "Tee", colourway = "Navy",
  quantity = 500, sampleStyleId = undefined, deliveryDate = "2026-11-20",
  factory = "", lifecycle = "OPEN",
} = {}) {
  const n = ++seq;
  const styleId = sampleStyleId === undefined ? new mongoose.Types.ObjectId() : sampleStyleId;
  return ExecutionFile.create({
    fileNumber: `EF-${n}-${lineRef}`,
    companyId: co._id,
    handoverRef: orderRef,
    handoverLineRef: lineRef,
    currentHandoverVersionId: new mongoose.Types.ObjectId(),
    lifecycleStatus: lifecycle,
    factoryRef: factory,
    currentExecutionProjection: {
      orderRef,
      orderLineRef: lineRef,
      styleRef: styleName,
      productName: styleName,
      sampleStyleId: styleId,
      buyerDisplayLabel: "Northwind Apparel",
      brandDisplayLabel: "Northwind",
      totalQuantity: quantity,
      breakdown: [{
        lineSplitRef: `${lineRef}-S1`,
        sizeRange: "S-XL",
        quantity,
        attributes: [{ name: "Colour", value: colourway }],
      }],
      deliveries: [{
        dropRef: `${lineRef}-D1`,
        committedDeliveryDate: new Date(deliveryDate),
        quantity,
        nominatedFactoryRef: factory,
      }],
      deliveryRequirement: "Sea freight, consolidated.",
    },
  });
}

/** A submitted pack, and optionally PPC's acceptance of that exact version. */
async function pack(co, file, { versionNo = 1, state = "SUBMITTED", accepted = true } = {}) {
  const doc = await ExecutionPack.create({
    companyId: co._id, fileId: file._id, packVersionNo: versionNo, state,
    completeness: { allPassed: true },
    submittedAt: new Date("2026-09-01"),
  });
  await ExecutionFile.updateOne({ _id: file._id },
    { $set: { currentPackVersionNo: versionNo } });
  if (accepted) {
    await DownstreamHandoverReceipt.create({
      companyId: co._id, packId: doc._id, packVersionNo: versionNo, fileId: file._id,
      state: "ACCEPTED", decidedAt: new Date("2026-09-02"),
      decidedBy: { id: new mongoose.Types.ObjectId(), name: "PPC" },
    });
  }
  return doc;
}

/**
 * Issued minutes, with the source snapshot Merchandising's capture would take.
 *
 * The snapshot is part of the record now: PPC compares which engineering
 * release the meeting reviewed with the one a plan would freeze, and minutes
 * carrying none are legacy evidence a NEW plan may not be made on. So the
 * style's current issued release is resolved at call time — which means a
 * world creates its release before its minutes, as a real meeting reviews a
 * release that already exists.
 */
async function minutes(co, file, {
  versionNo = 1, state = "ISSUED", reviewedRelease, contractVersion = 2,
} = {}) {
  const n = ++seq;
  const styleId = file.currentExecutionProjection?.sampleStyleId || null;
  let reviewed = reviewedRelease;
  if (reviewed === undefined) {
    const doc = styleId
      ? await IeRelease.findOne({ companyId: co._id, sampleStyleId: styleId, state: "ISSUED" })
        .sort({ versionNo: -1 }).select("_id releaseRef versionNo").lean()
      : null;
    reviewed = doc
      ? { recordId: doc._id, reference: doc.releaseRef, versionNo: doc.versionNo, state: "ISSUED" }
      : null;
  }
  return PreProductionMeeting.create({
    companyId: co._id, fileId: file._id,
    fileNumber: file.fileNumber,
    handoverRef: file.handoverRef, handoverLineRef: file.handoverLineRef,
    orderRef: file.handoverRef, orderLineRef: file.handoverLineRef,
    ppmRef: `PPM-${n}`, versionNo, state,
    issuedAt: state === "ISSUED" || state === "SUPERSEDED" ? new Date("2026-09-03") : null,
    ...(contractVersion === null ? {} : {
      sourcesCapturedAt: new Date("2026-09-03"),
      sourcesContractVersion: contractVersion,
      sourceReferences: [{
        key: "IE_RELEASE", label: "Engineering release",
        availability: reviewed ? "PRESENT" : "NOT_REPORTED",
        recordId: reviewed?.recordId ?? null,
        reference: reviewed?.reference ?? "",
        versionNo: reviewed?.versionNo ?? null,
        revisionNo: null, state: reviewed?.state ?? "", sourceUpdatedAt: null, note: "",
      }],
    }),
  });
}

/** An IE release for a style, and optionally PPC's acceptance of that version. */
async function release(co, sampleStyleId, {
  versionNo = 1, state = "ISSUED", accepted = true,
} = {}) {
  const n = ++seq;
  const doc = await IeRelease.create({
    companyId: co._id,
    releaseRef: `IEREL-${String(n).padStart(10, "0")}`,
    versionNo,
    ieStyleFileId: new mongoose.Types.ObjectId(),
    sampleStyleId,
    state,
    aggregateFingerprint: `${n}`.padStart(64, "f"),
    source: {
      bulletinVersionId: new mongoose.Types.ObjectId(),
      bulletinVersionNo: 1,
      sourceFingerprint: `${n}`.padStart(64, "a"),
      rows: [],
      garmentSamMinutes: 4.5,
      samRowCount: 4,
      lineLayout: { stationCount: 2, stations: [], metrics: { stationCount: 2 } },
      capacityStandard: {
        inputs: { plannedOperatorCount: 25 },
        calculation: { targetPiecesPerDay: 100 },
        readiness: { state: "PROVISIONAL", ready: false, gaps: [] },
      },
      capturedAt: new Date("2026-09-01"),
    },
    issuedBy: new mongoose.Types.ObjectId(),
    issuedByName: "IE",
    issuedAt: new Date("2026-09-01"),
  });
  if (accepted) {
    await IeReleaseReceipt.create({
      companyId: co._id, releaseRef: doc.releaseRef, releaseVersionNo: versionNo,
      ieReleaseId: doc._id, ieStyleFileId: doc.ieStyleFileId,
      state: "ACCEPTED", decidedAt: new Date("2026-09-02"),
      decidedBy: { id: new mongoose.Types.ObjectId(), name: "PPC" },
      idempotencyKey: `k-${n}`, requestHash: `h-${n}`,
    });
  }
  return doc;
}

/** Store's own statement about itself — context, never a gate. */
const storeStatus = (co, file, { statusCode = "MATERIAL_SHORT", availability = "AVAILABLE" } = {}) =>
  DepartmentStatusProjection.create({
    companyId: co._id, fileId: file._id,
    projectionRef: `DSP-${++seq}`,
    department: "STORE",
    sourceApp: "store", sourceRecordRef: `SR-${seq}`,
    statusCode, statusLabel: "Fabric short by 200m",
    availability,
    sourceObservedAt: new Date("2026-09-04"), receivedAt: new Date("2026-09-04"),
    isCurrent: true,
  });

/** A company with PPC people and one fully ready line. */
async function readyWorld(label, lineOpts = {}) {
  const co = await company(label);
  const file = await orderLine(co, { lineRef: `L-${label}-${++seq}`, ...lineOpts });
  const styleId = file.currentExecutionProjection.sampleStyleId;
  await pack(co, file);
  /* The release first: the minutes record WHICH release was reviewed, so it
     has to exist before the meeting that reviewed it. */
  const rel = await release(co, styleId);
  await minutes(co, file);
  return {
    co, file, rel, styleId,
    lineRef: file.handoverLineRef,
    viewer: await actor({ companies: [co], grants: { ppc: "viewer" } }),
    planner: await actor({ companies: [co], grants: { ppc: "editor" } }),
    approver: await actor({ companies: [co], grants: { ppc: "approver" } }),
  };
}

const createPlan = (w, who = w.planner, body = {}) => ppc(
  `/order-book/${w.lineRef}/planning-file`,
  { method: "POST", token: who.token, company: w.co._id, body, key: nextKey() },
);

/* ══ 1. ELIGIBILITY — THE BOOK SHOWS INCOMPLETE LINES ═════════════════════ */

describe("a confirmed order line is in the book even with nothing attached", () => {
  test("it appears, and each missing input is stated as missing", async () => {
    const co = await company("Bare");
    const file = await orderLine(co, { lineRef: "L-BARE-1" });
    const viewer = await actor({ companies: [co], grants: { ppc: "viewer" } });

    const res = await ppc("/order-book?view=all", { token: viewer.token, company: co._id });
    expect(res.status).toBe(200);
    const row = res.body.rows.find((r) => r.orderLineRef === "L-BARE-1");
    expect(row).toBeTruthy();

    /* Eligible — and NOT ready, which are two different answers. */
    expect(row.eligible).toBe(true);
    expect(row.readyToPlan).toBe(false);

    /* The order line itself is satisfied; the other three are honestly absent. */
    expect(row.inputs.orderLine.state).toBe("SATISFIED");
    expect(row.inputs.executionPack.state).toBe("MISSING");
    expect(row.inputs.ieRelease.state).toBe("MISSING");
    expect(row.inputs.ppmMinutes.state).toBe("MISSING");

    /* And it is in the awaiting-inputs view, not hidden from every view. */
    expect(row.view).toBe("awaiting-inputs");
    expect(row.planningFileId).toBeNull();
    expect(file.handoverLineRef).toBe("L-BARE-1");
  });

  test("a partially complete line names exactly what is outstanding", async () => {
    const co = await company("Partial");
    const file = await orderLine(co, { lineRef: "L-PART-1" });
    await pack(co, file);                                  // accepted
    await minutes(co, file, { state: "DRAFT" });           // not issued
    const viewer = await actor({ companies: [co], grants: { ppc: "viewer" } });

    const res = await ppc("/order-book?view=all", { token: viewer.token, company: co._id });
    const row = res.body.rows.find((r) => r.orderLineRef === "L-PART-1");
    expect(row.inputs.executionPack.state).toBe("SATISFIED");
    expect(row.inputs.ieRelease.state).toBe("MISSING");
    /* A draft meeting is not minutes. It is not published at all, so it is
       MISSING rather than PENDING — there is nothing anybody may rely on. */
    expect(row.inputs.ppmMinutes.state).toBe("MISSING");
    expect(row.unsatisfiedInputs.sort()).toEqual(["ieRelease", "ppmMinutes"]);
    expect(row.readyToPlan).toBe(false);
  });

  test("a submitted but unaccepted pack is awaiting PPC, not missing", async () => {
    const co = await company("Unaccepted");
    const file = await orderLine(co, { lineRef: "L-UNACC-1" });
    await pack(co, file, { accepted: false });
    const viewer = await actor({ companies: [co], grants: { ppc: "viewer" } });

    const res = await ppc("/order-book?view=all", { token: viewer.token, company: co._id });
    const row = res.body.rows.find((r) => r.orderLineRef === "L-UNACC-1");
    expect(row.inputs.executionPack.state).toBe("PENDING");
    expect(row.inputWords.executionPack).toBe("Awaiting acceptance");
    expect(row.readyToPlan).toBe(false);
  });

  test("a pack accepted at an EARLIER version does not satisfy the current one", async () => {
    const co = await company("OldReceipt");
    const file = await orderLine(co, { lineRef: "L-OLD-1" });
    await pack(co, file, { versionNo: 1, state: "SUPERSEDED", accepted: true });
    await pack(co, file, { versionNo: 2, state: "SUBMITTED", accepted: false });
    const viewer = await actor({ companies: [co], grants: { ppc: "viewer" } });

    const res = await ppc("/order-book?view=all", { token: viewer.token, company: co._id });
    const row = res.body.rows.find((r) => r.orderLineRef === "L-OLD-1");
    /* The CURRENT pack is v2, which nobody has accepted. */
    expect(row.inputs.executionPack.versionNo).toBe(2);
    expect(row.inputs.executionPack.state).toBe("PENDING");
  });
});

/* ══ 2. A FAILED READ IS "COULDN’T CHECK" ═════════════════════════════════ */

describe("a failed source read is never missing, zero or ready", () => {
  /** Break ONE published contract for the duration of a test. */
  const breaking = async (moduleName, method, fn) => {
    const mod = require(moduleName);
    const original = mod[method];
    mod[method] = async () => { throw new Error("source unavailable"); };
    try { return await fn(); } finally { mod[method] = original; }
  };

  test("an unreadable IE release says Couldn’t check, and the row still renders", async () => {
    const w = await readyWorld("Unreadable");
    const res = await breaking(
      "../../services/industrialEngineering/releasePublication.service",
      "publishCurrentReleasesByStyle",
      () => ppc("/order-book?view=all", { token: w.viewer.token, company: w.co._id }),
    );
    expect(res.status).toBe(200);
    const row = res.body.rows.find((r) => r.orderLineRef === w.lineRef);

    expect(row.inputs.ieRelease.state).toBe("UNREADABLE");
    expect(row.inputWords.ieRelease).toBe("Couldn’t check");
    /* Not missing, not ready, and not counted as blocked. */
    expect(row.inputs.ieRelease.state).not.toBe("MISSING");
    expect(row.readyToPlan).toBe(false);
    expect(row.blocked).toBe(false);
    expect(row.undetermined).toBe(true);

    /* The row still carries everything that DID read. */
    expect(row.inputs.executionPack.state).toBe("SATISFIED");
    expect(row.inputs.ppmMinutes.state).toBe("SATISFIED");
    expect(row.confirmedQuantity).toBe(500);

    /* And the response names the source that failed. */
    expect(res.body.degraded).toBe(true);
    expect(res.body.faults.map((f) => f.source)).toContain("IE_RELEASE");
  });

  test("a line whose inputs cannot be read cannot be planned either", async () => {
    const w = await readyWorld("UnreadableCreate");
    const res = await breaking(
      "../../services/merchandising/planningPublication.service",
      "publishIssuedMeetingMinutes",
      () => createPlan(w),
    );
    /* 503, not 400: the planner did nothing wrong — a source could not be
       read, and telling them their request was invalid would send them editing
       a correct one. */
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("PPC_PLANNING_READINESS_UNDETERMINED");
    expect(res.body.error.details.unreadable).toContain("ppmMinutes");
    expect(await PpcPlanningFile.countDocuments({})).toBe(0);
  });

  test("when the order lines themselves cannot be read, the register refuses rather than showing an empty book", async () => {
    const w = await readyWorld("SpineDown");
    const res = await breaking(
      "../../services/merchandising/planningPublication.service",
      "publishConfirmedOrderLines",
      () => ppc("/order-book?view=all", { token: w.viewer.token, company: w.co._id }),
    );
    /* An empty register would read as "no confirmed orders", which is the one
       thing a failed read must never be allowed to say. */
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("PPC_ORDER_BOOK_UNAVAILABLE");
  });
});

/* ══ 3. READINESS ═════════════════════════════════════════════════════════ */

describe("exactly the accepted pack, the accepted release and issued minutes", () => {
  test("all four present makes a line ready to plan", async () => {
    const w = await readyWorld("Ready");
    const res = await ppc("/order-book?view=ready-to-plan",
      { token: w.viewer.token, company: w.co._id });
    expect(res.status).toBe(200);
    const row = res.body.rows.find((r) => r.orderLineRef === w.lineRef);
    expect(row).toBeTruthy();
    expect(row.readyToPlan).toBe(true);
    expect(row.view).toBe("ready-to-plan");
    for (const k of ["orderLine", "executionPack", "ieRelease", "ppmMinutes"]) {
      expect(row.inputs[k].state).toBe("SATISFIED");
    }
  });

  test("an unaccepted RELEASE is enough to hold it back", async () => {
    const co = await company("RelPending");
    const file = await orderLine(co, { lineRef: "L-RELP-1" });
    await pack(co, file);
    await minutes(co, file);
    await release(co, file.currentExecutionProjection.sampleStyleId, { accepted: false });
    const viewer = await actor({ companies: [co], grants: { ppc: "viewer" } });

    const res = await ppc("/order-book?view=all", { token: viewer.token, company: co._id });
    const row = res.body.rows.find((r) => r.orderLineRef === "L-RELP-1");
    expect(row.inputs.ieRelease.state).toBe("PENDING");
    expect(row.readyToPlan).toBe(false);
  });

  test("a line with no stable style identity says so, rather than silently having no release", async () => {
    const co = await company("NoStyle");
    await orderLine(co, { lineRef: "L-NOSTYLE-1", sampleStyleId: null });
    const viewer = await actor({ companies: [co], grants: { ppc: "viewer" } });

    const res = await ppc("/order-book?view=all", { token: viewer.token, company: co._id });
    const row = res.body.rows.find((r) => r.orderLineRef === "L-NOSTYLE-1");
    expect(row.inputs.ieRelease.state).toBe("MISSING");
    expect(row.inputs.ieRelease.reason).toBe("NO_STABLE_STYLE_IDENTITY");
  });

  test("readiness is not the words `production ready` anywhere on the wire", async () => {
    const w = await readyWorld("Words");
    const res = await ppc("/order-book?view=all", { token: w.viewer.token, company: w.co._id });
    expect(JSON.stringify(res.body)).not.toMatch(/production[ _-]?ready/i);
  });
});

/* ══ 4. STORE IS CONTEXT, NOT A GATE ═════════════════════════════════════ */

describe("Store and Supply status is context and never a PPC gate", () => {
  test("a material shortage is shown, and the line is still ready to plan", async () => {
    const w = await readyWorld("StoreShort");
    await storeStatus(w.co, w.file);

    const res = await ppc("/order-book?view=all", { token: w.viewer.token, company: w.co._id });
    const row = res.body.rows.find((r) => r.orderLineRef === w.lineRef);

    /* Shown... */
    expect(row.material.statements[0].statusCode).toBe("MATERIAL_SHORT");
    expect(row.material.statements[0].department).toBe("STORE");
    /* ...and decides nothing. */
    expect(row.readyToPlan).toBe(true);
    expect(row.unsatisfiedInputs).toEqual([]);

    /* And a planning file can be created despite it. */
    const created = await createPlan(w);
    expect(created.status).toBe(201);
  });

  test("material is not among the required inputs, structurally", async () => {
    const w = await readyWorld("StoreStructure");
    const res = await ppc("/order-book/summary", { token: w.viewer.token, company: w.co._id });
    expect(res.status).toBe(200);
    expect(res.body.requiredInputs.map((i) => i.key)).toEqual([
      "orderLine", "executionPack", "ieRelease", "ppmMinutes",
    ]);
    expect(res.body.contextInputs.map((i) => i.key)).toEqual(["material"]);
  });

  test("silence from Store is not reported as nothing to report", async () => {
    const w = await readyWorld("StoreSilent");
    const res = await ppc("/order-book?view=all", { token: w.viewer.token, company: w.co._id });
    const row = res.body.rows.find((r) => r.orderLineRef === w.lineRef);
    expect(row.material.statements).toEqual([]);
    expect(row.material.availability).toBe("UNKNOWN");
  });
});

/* ══ 5-6. IDENTITY BY THE PERMANENT LINE REFERENCE ═══════════════════════ */

describe("identity is the permanent line reference, never a name", () => {
  test("two lines of one order sharing a style and a colourway name stay separate", async () => {
    const co = await company("SameName");
    const styleId = new mongoose.Types.ObjectId();
    /* One style, one colourway NAME, two commercial lines — the exact shape
       that a join on style or colour would silently merge. */
    const a = await orderLine(co, {
      lineRef: "L-SAME-A", orderRef: "ORD-SAME", styleName: "Tee",
      colourway: "Navy", sampleStyleId: styleId, quantity: 300,
    });
    const b = await orderLine(co, {
      lineRef: "L-SAME-B", orderRef: "ORD-SAME", styleName: "Tee",
      colourway: "Navy", sampleStyleId: styleId, quantity: 700,
    });
    await release(co, styleId);
    for (const f of [a, b]) { await pack(co, f); await minutes(co, f); }

    const planner = await actor({ companies: [co], grants: { ppc: "editor" } });
    const viewer = await actor({ companies: [co], grants: { ppc: "viewer" } });

    const reg = await ppc("/order-book?view=all", { token: viewer.token, company: co._id });
    const refs = reg.body.rows.map((r) => r.orderLineRef).sort();
    expect(refs).toEqual(["L-SAME-A", "L-SAME-B"]);
    /* Both are ready, and they share ONE engineering release — which is
       correct: a release is per style. */
    const rows = reg.body.rows;
    expect(rows.every((r) => r.readyToPlan)).toBe(true);
    expect(new Set(rows.map((r) => r.inputs.ieRelease.releaseId)).size).toBe(1);

    /* Planning one does not plan the other. */
    const planA = await ppc("/order-book/L-SAME-A/planning-file", {
      method: "POST", token: planner.token, company: co._id, body: {}, key: nextKey(),
    });
    expect(planA.status).toBe(201);
    expect(planA.body.planningFile.orderLineRef).toBe("L-SAME-A");

    const after = await ppc("/order-book?view=all", { token: viewer.token, company: co._id });
    const rowA = after.body.rows.find((r) => r.orderLineRef === "L-SAME-A");
    const rowB = after.body.rows.find((r) => r.orderLineRef === "L-SAME-B");
    expect(rowA.planningFileId).toBeTruthy();
    expect(rowB.planningFileId).toBeNull();
    expect(rowB.readyToPlan).toBe(true);

    /* And the two plans, once both exist, are two records with two references. */
    const planB = await ppc("/order-book/L-SAME-B/planning-file", {
      method: "POST", token: planner.token, company: co._id, body: {}, key: nextKey(),
    });
    expect(planB.status).toBe(201);
    expect(planB.body.planningFile.planningFileRef)
      .not.toBe(planA.body.planningFile.planningFileRef);
    expect(await PpcPlanningFile.countDocuments({ companyId: co._id })).toBe(2);
  });

  test("the planning file's stored identity is the line ref, the file ref and the style id", async () => {
    const w = await readyWorld("Identity");
    const created = await createPlan(w);
    expect(created.status).toBe(201);

    const stored = await PpcPlanningFile.findOne({ companyId: w.co._id }).lean();
    expect(stored.orderLineRef).toBe(w.lineRef);
    expect(String(stored.executionFileId)).toBe(String(w.file._id));
    expect(stored.executionFileRef).toBe(w.file.fileNumber);
    expect(String(stored.sampleStyleId)).toBe(String(w.styleId));
    expect(stored.orderRef).toBeTruthy();
    expect(stored.planningFileRef).toMatch(/^PPCPF-[0-9A-F]{10}$/);
  });
});

/* ══ 7. ONE ACTIVE FILE PER LINE ═════════════════════════════════════════ */

describe("one active planning file per line", () => {
  test("a second create returns the first, and does not make a second record", async () => {
    const w = await readyWorld("OnePer");
    const first = await createPlan(w);
    expect(first.status).toBe(201);
    expect(first.body.created).toBe(true);

    /* A DIFFERENT key, so this is not an idempotent replay — it is a genuine
       second attempt, and it must find the existing file. */
    const second = await createPlan(w);
    expect(second.status).toBe(200);
    expect(second.body.created).toBe(false);
    expect(second.body.planningFile.planningFileId)
      .toBe(first.body.planningFile.planningFileId);
    expect(await PpcPlanningFile.countDocuments({ companyId: w.co._id })).toBe(1);
  });

  test("two simultaneous creates produce ONE record, and no duplicate-key error escapes", async () => {
    const w = await readyWorld("Concurrent");
    const [a, b] = await Promise.all([createPlan(w), createPlan(w)]);
    for (const r of [a, b]) {
      expect([200, 201]).toContain(r.status);
      expect(r.body.success).toBe(true);
      expect(JSON.stringify(r.body)).not.toMatch(/E11000|duplicate key/i);
    }
    expect(await PpcPlanningFile.countDocuments({ companyId: w.co._id })).toBe(1);
    expect(a.body.planningFile.planningFileId).toBe(b.body.planningFile.planningFileId);
  });

  test("the partial index is over the ACTIVE states, so a successor is not blocked", async () => {
    const idx = PpcPlanningFile.schema.indexes()
      .find(([, opts]) => opts?.name === "ppc_planning_one_active_per_line");
    expect(idx).toBeTruthy();
    expect(idx[1].unique).toBe(true);
    expect([...idx[1].partialFilterExpression.state.$in].sort())
      .toEqual(["ON_HOLD", "OPEN", "PLANNED", "PLANNING"]);
  });
});

/* ══ 8-9. UPSTREAM IDENTITIES ARE SERVER-DERIVED ═════════════════════════ */

describe("upstream identities are the server's, and a forged one is refused by name", () => {
  test("a create carrying a pack version, a release id or a basis is refused", async () => {
    const w = await readyWorld("Forged");
    const forged = await ppc(`/order-book/${w.lineRef}/planning-file`, {
      method: "POST", token: w.planner.token, company: w.co._id, key: nextKey(),
      body: {
        sourceBasis: { confirmedQuantity: 1 },
        ieReleaseId: String(new mongoose.Types.ObjectId()),
        executionPackVersionNo: 99,
        state: "PLANNED",
      },
    });
    expect(forged.status).toBe(400);
    expect(forged.body.error.code).toBe("PPC_PLANNING_FIELD_REFUSED");
    /* Named individually, each with its reason — never "unknown field". */
    expect(forged.body.error.details.fields.sort()).toEqual(
      ["executionPackVersionNo", "ieReleaseId", "sourceBasis", "state"],
    );
    expect(forged.body.error.details.because.sourceBasis).toMatch(/server/i);
    expect(await PpcPlanningFile.countDocuments({})).toBe(0);
  });

  test("the basis the server froze is the one the sources actually say", async () => {
    const w = await readyWorld("Derived");
    const created = await createPlan(w);
    const b = created.body.planningFile.sourceBasis;
    expect(b.confirmedQuantity).toBe(500);
    expect(b.executionPackVersionNo).toBe(1);
    expect(b.executionPackState).toBe("SUBMITTED");
    expect(b.packReceiptState).toBe("ACCEPTED");
    expect(b.ieReleaseRef).toBe(w.rel.releaseRef);
    expect(b.ieReleaseVersionNo).toBe(1);
    expect(b.ieReceiptState).toBe("ACCEPTED");
    expect(b.ppmVersionNo).toBe(1);
    expect(b.ppmState).toBe("ISSUED");
  });

  test("later PPC chunks' fields are refused now, by name", async () => {
    const w = await readyWorld("LaterChunks");
    const created = await createPlan(w);
    const id = created.body.planningFile.planningFileId;
    for (const field of ["lineId", "shiftId", "bookedMinutes", "dailyTarget",
      "productionReleaseNo", "workOrderId"]) {
      const res = await ppc(`/planning-files/${id}`, {
        method: "PATCH", token: w.planner.token, company: w.co._id,
        body: { expectedRevision: 1, [field]: "x" },
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("PPC_PLANNING_FIELD_REFUSED");
      expect(res.body.error.details.fields).toEqual([field]);
    }
  });

  test("an unknown field is refused rather than silently dropped", async () => {
    const w = await readyWorld("Unknown");
    const created = await createPlan(w);
    const res = await ppc(`/planning-files/${created.body.planningFile.planningFileId}`, {
      method: "PATCH", token: w.planner.token, company: w.co._id,
      body: { expectedRevision: 1, somethingElse: 1 },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("PPC_PLANNING_FIELD_UNKNOWN");
  });
});

/* ══ 10. THE FROZEN BASIS IS IMMUTABLE ═══════════════════════════════════ */

describe("the frozen basis cannot be rewritten", () => {
  test("every path in it is immutable at the schema, so a save cannot move it", async () => {
    const w = await readyWorld("Immutable");
    const created = await createPlan(w);
    const id = created.body.planningFile.planningFileId;

    const doc = await PpcPlanningFile.findById(id);
    doc.sourceBasis.confirmedQuantity = 9999;
    doc.sourceBasis.ieReleaseVersionNo = 42;
    doc.sourceBasis.executionPackVersionNo = 42;
    doc.markModified("sourceBasis");
    await doc.save();

    const after = await PpcPlanningFile.findById(id).lean();
    expect(after.sourceBasis.confirmedQuantity).toBe(500);
    expect(after.sourceBasis.ieReleaseVersionNo).toBe(1);
    expect(after.sourceBasis.executionPackVersionNo).toBe(1);
  });

  test("no route offers a way to edit it", async () => {
    const router = require("../../routes/CMS_Routes/PPC/orderBookRoute");
    const paths = router.stack.filter((l) => l.route).map((l) => l.route.path);
    expect(paths.filter((p) => /basis|freeze|rebase|re-base/i.test(p))).toEqual([]);
  });
});

/* ══ 11-12. SOURCE MOVEMENT AND THE SUCCESSOR ════════════════════════════ */

describe("source movement is detected, and a successor preserves the old plan", () => {
  test("a new release version shows the plan as source-moved, with what moved", async () => {
    const w = await readyWorld("Moved");
    const created = await createPlan(w);
    const id = created.body.planningFile.planningFileId;

    /* IE issues version 2 and supersedes version 1 — its own move, mirrored
       here as the records would look afterwards. */
    /* Superseding is IE's own conditional move and it refuses any write
       outside the transaction that issues the successor — which is IE's
       protection working. The raw collection write stands in for it here, the
       same way `ppc-ie-release-receipt.route.test.js` does, because this suite
       must not drive an IE verb to test PPC's reading of the result. */
    await mongoose.connection.collection("ie_releases").updateOne(
      { _id: w.rel._id },
      { $set: { state: "SUPERSEDED", supersededByVersionNo: 2 } },
    );
    await release(w.co, w.styleId, { versionNo: 2, accepted: true });

    const health = await ppc(`/planning-files/${id}/source-health`,
      { token: w.viewer.token, company: w.co._id });
    expect(health.status).toBe(200);
    expect(health.body.moved).toBe(true);
    const moved = health.body.movements.find((m) => m.key === "ieRelease");
    expect(moved).toBeTruthy();
    expect(moved.kind).toBe("STATE_CHANGED");
    expect(moved.from).toBe("ISSUED");
    expect(moved.to).toBe("SUPERSEDED");

    /* The frozen basis still says what it always said. */
    expect(health.body.frozen.ieReleaseVersionNo).toBe(1);
    expect(health.body.frozen.ieReleaseState).toBe("ISSUED");

    /* And the register warns on the row. */
    const reg = await ppc("/order-book?view=all", { token: w.viewer.token, company: w.co._id });
    const row = reg.body.rows.find((r) => r.orderLineRef === w.lineRef);
    expect(row.sourceMoved).toBe(true);
  });

  test("a changed confirmed quantity is a movement too", async () => {
    const w = await readyWorld("QtyMoved");
    const created = await createPlan(w);
    await ExecutionFile.updateOne({ _id: w.file._id },
      { $set: { "currentExecutionProjection.totalQuantity": 640 } });

    const health = await ppc(
      `/planning-files/${created.body.planningFile.planningFileId}/source-health`,
      { token: w.viewer.token, company: w.co._id },
    );
    expect(health.body.moved).toBe(true);
    const m = health.body.movements.find((x) => x.key === "confirmedQuantity");
    expect(m.from).toBe(500);
    expect(m.to).toBe(640);
  });

  test("a successor preserves the predecessor entirely, and takes over the line", async () => {
    const w = await readyWorld("Successor");
    const created = await createPlan(w, w.planner, { priority: "HIGH", planningNote: "First pass" });
    const first = created.body.planningFile;

    /* Move a source, then replace the plan explicitly. */
    await ExecutionPack.updateOne({ companyId: w.co._id, fileId: w.file._id },
      { $set: { state: "SUPERSEDED" } });
    await pack(w.co, w.file, { versionNo: 2, state: "SUBMITTED", accepted: true });

    const successor = await ppc(`/planning-files/${first.planningFileId}/successor`, {
      method: "POST", token: w.approver.token, company: w.co._id, key: nextKey(),
      body: {
        expectedRevision: first.revision,
        reason: "The execution pack moved to version 2 and PPC accepted it.",
      },
    });
    expect(successor.status).toBe(201);
    const next = successor.body.planningFile;

    /* The successor is generation 2, planned against the NEW basis. */
    expect(next.generation).toBe(2);
    expect(next.state).toBe("OPEN");
    expect(next.sourceBasis.executionPackVersionNo).toBe(2);
    expect(next.supersedesFileRef).toBe(first.planningFileRef);
    /* PPC's own intentions carry forward — the SOURCES moved, not the plan. */
    expect(next.planning.priority).toBe("HIGH");
    expect(next.planning.planningNote).toBe("First pass");

    /* The predecessor is preserved, in full, and no longer owns the line. */
    const old = await ppc(`/planning-files/${first.planningFileId}`,
      { token: w.viewer.token, company: w.co._id });
    expect(old.status).toBe(200);
    expect(old.body.planningFile.state).toBe("SUPERSEDED");
    expect(old.body.planningFile.ownsLine).toBe(false);
    expect(old.body.planningFile.sourceBasis.executionPackVersionNo).toBe(1);
    expect(old.body.planningFile.supersededByFileRef).toBe(next.planningFileRef);
    expect(old.body.planningFile.planning.planningNote).toBe("First pass");

    /* Two records exist, and exactly one is active. */
    const all = await PpcPlanningFile.find({ companyId: w.co._id }).lean();
    expect(all).toHaveLength(2);
    expect(all.filter((f) => ["OPEN", "PLANNING", "PLANNED", "ON_HOLD"]
      .includes(f.state))).toHaveLength(1);
  });

  test("a successor needs a reason worth reading", async () => {
    const w = await readyWorld("SuccReason");
    const created = await createPlan(w);
    const res = await ppc(`/planning-files/${created.body.planningFile.planningFileId}/successor`, {
      method: "POST", token: w.approver.token, company: w.co._id, key: nextKey(),
      body: { reason: "moved" },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("PPC_SUCCESSOR_REASON_REQUIRED");
  });
});

/* ══ 13. COMPANY ISOLATION ═══════════════════════════════════════════════ */

describe("company isolation", () => {
  test("another company's line and plan are invisible and unreachable", async () => {
    const mine = await readyWorld("Mine");
    const theirs = await readyWorld("Theirs");
    const created = await createPlan(theirs);
    expect(created.status).toBe(201);
    const theirPlanId = created.body.planningFile.planningFileId;

    /* My register does not contain their line. */
    const reg = await ppc("/order-book?view=all",
      { token: mine.viewer.token, company: mine.co._id });
    expect(reg.body.rows.map((r) => r.orderLineRef)).not.toContain(theirs.lineRef);

    /* Their plan is not readable with my company header. */
    const read = await ppc(`/planning-files/${theirPlanId}`,
      { token: mine.viewer.token, company: mine.co._id });
    expect(read.status).toBe(404);
    expect(read.body.error.code).toBe("PPC_PLANNING_FILE_NOT_FOUND");

    /* And their line cannot be planned by me. */
    const forge = await ppc(`/order-book/${theirs.lineRef}/planning-file`, {
      method: "POST", token: mine.planner.token, company: mine.co._id, body: {}, key: nextKey(),
    });
    expect(forge.status).toBe(404);
    expect(forge.body.error.code).toBe("PPC_ORDER_LINE_NOT_FOUND");
  });

  test("a malformed id is the typed not-found, never a cast error", async () => {
    const w = await readyWorld("Malformed");
    const res = await ppc("/planning-files/not-an-id",
      { token: w.viewer.token, company: w.co._id });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("PPC_PLANNING_FILE_NOT_FOUND");
    expect(JSON.stringify(res.body)).not.toMatch(/CastError|ObjectId/i);
  });
});

/* ══ 14. THE CAPABILITY MATRIX ═══════════════════════════════════════════ */

describe("viewer reads, planner writes, approver decides", () => {
  test("the whole matrix, one rung at a time", async () => {
    const w = await readyWorld("Matrix");
    const outsider = await actor({ companies: [w.co], grants: { merchandiser: "approver" } });
    const ieOnly = await actor({ companies: [w.co], grants: { ie: "approver" } });

    /* ── READ: viewer and up; nobody without a PPC grant ──────────────── */
    for (const who of [w.viewer, w.planner, w.approver]) {
      const r = await ppc("/order-book?view=all", { token: who.token, company: w.co._id });
      expect(r.status).toBe(200);
    }
    for (const who of [outsider, ieOnly]) {
      const r = await ppc("/order-book?view=all", { token: who.token, company: w.co._id });
      expect(r.status).toBe(403);
    }

    /* ── CREATE: editor and up; a viewer cannot ───────────────────────── */
    const asViewer = await createPlan(w, w.viewer);
    expect(asViewer.status).toBe(403);
    expect(await PpcPlanningFile.countDocuments({})).toBe(0);

    const asPlanner = await createPlan(w, w.planner);
    expect(asPlanner.status).toBe(201);
    const id = asPlanner.body.planningFile.planningFileId;
    let rev = asPlanner.body.planningFile.revision;

    /* ── EDIT: editor and up ──────────────────────────────────────────── */
    const viewerEdit = await ppc(`/planning-files/${id}`, {
      method: "PATCH", token: w.viewer.token, company: w.co._id,
      body: { expectedRevision: rev, priority: "HIGH" },
    });
    expect(viewerEdit.status).toBe(403);

    const plannerEdit = await ppc(`/planning-files/${id}`, {
      method: "PATCH", token: w.planner.token, company: w.co._id,
      body: { expectedRevision: rev, priority: "HIGH" },
    });
    expect(plannerEdit.status).toBe(200);
    rev = plannerEdit.body.planningFile.revision;

    /* ── PLANNING STARTED: a planner's own act ────────────────────────── */
    const started = await ppc(`/planning-files/${id}/planning-started`, {
      method: "POST", token: w.planner.token, company: w.co._id,
      body: { expectedRevision: rev }, key: nextKey(),
    });
    expect(started.status).toBe(200);
    rev = started.body.planningFile.revision;

    /* ── MARK PLANNED: approver only ──────────────────────────────────── */
    const plannerPlans = await ppc(`/planning-files/${id}/planned`, {
      method: "POST", token: w.planner.token, company: w.co._id,
      body: { expectedRevision: rev }, key: nextKey(),
    });
    expect(plannerPlans.status).toBe(403);
    expect(plannerPlans.body.error.details.requires.capability).toBe("ppc.planning.approve");

    const approverPlans = await ppc(`/planning-files/${id}/planned`, {
      method: "POST", token: w.approver.token, company: w.co._id,
      body: { expectedRevision: rev }, key: nextKey(),
    });
    expect(approverPlans.status).toBe(200);
    expect(approverPlans.body.planningFile.state).toBe("PLANNED");
    rev = approverPlans.body.planningFile.revision;

    /* ── HOLD: approver only ──────────────────────────────────────────── */
    const plannerHolds = await ppc(`/planning-files/${id}/hold`, {
      method: "POST", token: w.planner.token, company: w.co._id,
      body: { expectedRevision: rev, reason: "AWAITING_MATERIAL" }, key: nextKey(),
    });
    expect(plannerHolds.status).toBe(403);

    const approverHolds = await ppc(`/planning-files/${id}/hold`, {
      method: "POST", token: w.approver.token, company: w.co._id,
      body: { expectedRevision: rev, reason: "AWAITING_MATERIAL" }, key: nextKey(),
    });
    expect(approverHolds.status).toBe(200);
    expect(approverHolds.body.planningFile.state).toBe("ON_HOLD");
    rev = approverHolds.body.planningFile.revision;

    /* Lifting it returns to PLANNED, not to OPEN — a hold is not a reset. */
    const lifted = await ppc(`/planning-files/${id}/hold/remove`, {
      method: "POST", token: w.approver.token, company: w.co._id,
      body: { expectedRevision: rev, note: "Fabric lot confirmed by the mill today." }, key: nextKey(),
    });
    expect(lifted.status).toBe(200);
    expect(lifted.body.planningFile.state).toBe("PLANNED");
  });

  test("permission comes from the live grant, not a URL parameter or a token claim", async () => {
    const w = await readyWorld("NoBypass");
    /* A query parameter that names a role reaches nothing. */
    const res = await ppc("/order-book?view=all&role=approver&ppcRole=owner",
      { token: w.viewer.token, company: w.co._id });
    expect(res.status).toBe(200);
    const create = await ppc(`/order-book/${w.lineRef}/planning-file?role=editor`, {
      method: "POST", token: w.viewer.token, company: w.co._id, body: {}, key: nextKey(),
    });
    expect(create.status).toBe(403);

    /* A token claiming a role it was not granted reaches nothing either. */
    const liar = jwt.sign(
      { id: String(new mongoose.Types.ObjectId()), email: "liar@grav.test",
        name: "Liar", role: "admin", isAdmin: true, ppcRole: "approver" },
      process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" },
    );
    const asLiar = await ppc("/order-book?view=all", { token: liar, company: w.co._id });
    expect(asLiar.status).toBe(403);
  });

  test("the ladder names three planning capabilities and maps them to three rungs", () => {
    const { CAPABILITY, MINIMUM_ROLE } = require("../../services/ppc/access.service");
    expect(MINIMUM_ROLE[CAPABILITY.PLANNING_READ]).toBe("viewer");
    expect(MINIMUM_ROLE[CAPABILITY.PLANNING_WRITE]).toBe("editor");
    expect(MINIMUM_ROLE[CAPABILITY.PLANNING_APPROVE]).toBe("approver");
  });
});

/* ══ 15-17. CONCURRENCY AND IDEMPOTENCY ══════════════════════════════════ */

describe("stale revisions conflict, and a replay is identical", () => {
  test("an edit sent against a stale revision is refused with the current one", async () => {
    const w = await readyWorld("Stale");
    const created = await createPlan(w);
    const id = created.body.planningFile.planningFileId;

    const first = await ppc(`/planning-files/${id}`, {
      method: "PATCH", token: w.planner.token, company: w.co._id,
      body: { expectedRevision: 1, priority: "HIGH" },
    });
    expect(first.status).toBe(200);
    expect(first.body.planningFile.revision).toBe(2);

    const stale = await ppc(`/planning-files/${id}`, {
      method: "PATCH", token: w.planner.token, company: w.co._id,
      body: { expectedRevision: 1, priority: "LOW" },
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("PPC_PLANNING_REVISION_STALE");
    expect(stale.body.error.details.currentRevision).toBe(2);

    /* And the losing edit changed nothing. */
    const now = await PpcPlanningFile.findById(id).lean();
    expect(now.planning.priority).toBe("HIGH");
    expect(now.revision).toBe(2);
  });

  test("a missing expectedRevision is refused rather than defaulted", async () => {
    const w = await readyWorld("NoRev");
    const created = await createPlan(w);
    const res = await ppc(`/planning-files/${created.body.planningFile.planningFileId}`, {
      method: "PATCH", token: w.planner.token, company: w.co._id, body: { priority: "LOW" },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("PPC_EXPECTED_REVISION_REQUIRED");
  });

  test("a state command replays EXACTLY under the same key, and is refused for a different request", async () => {
    const w = await readyWorld("Replay");
    const created = await createPlan(w);
    const id = created.body.planningFile.planningFileId;
    const rev = created.body.planningFile.revision;

    const key = nextKey();
    const first = await ppc(`/planning-files/${id}/planning-started`, {
      method: "POST", token: w.planner.token, company: w.co._id,
      body: { expectedRevision: rev }, key,
    });
    expect(first.status).toBe(200);
    expect(first.body.replayed).toBe(false);

    const again = await ppc(`/planning-files/${id}/planning-started`, {
      method: "POST", token: w.planner.token, company: w.co._id,
      body: { expectedRevision: rev }, key,
    });
    expect(again.status).toBe(200);
    expect(again.body.replayed).toBe(true);
    /* Byte-identical apart from the flag that says it was a replay. */
    expect({ ...again.body, replayed: false }).toEqual(first.body);

    /* One transition happened, not two. */
    const doc = await PpcPlanningFile.findById(id).lean();
    expect(doc.state).toBe("PLANNING");
    expect(doc.history.filter((e) => e.type === "PLANNING_STARTED")).toHaveLength(1);

    /* The same key on a different command is refused. */
    const reused = await ppc(`/planning-files/${id}/planned`, {
      method: "POST", token: w.approver.token, company: w.co._id,
      body: { expectedRevision: doc.revision }, key,
    });
    expect(reused.status).toBe(409);
    expect(reused.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  test("a state command with no key at all is refused", async () => {
    const w = await readyWorld("NoKey");
    const created = await createPlan(w);
    const res = await ppc(`/planning-files/${created.body.planningFile.planningFileId}/planning-started`, {
      method: "POST", token: w.planner.token, company: w.co._id,
      body: { expectedRevision: 1 },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
  });

  test("an out-of-order transition is refused with the states that were allowed", async () => {
    const w = await readyWorld("OutOfOrder");
    const created = await createPlan(w);
    /* OPEN cannot go straight to PLANNED. */
    const res = await ppc(`/planning-files/${created.body.planningFile.planningFileId}/planned`, {
      method: "POST", token: w.approver.token, company: w.co._id,
      body: { expectedRevision: 1 }, key: nextKey(),
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("PPC_PLANNING_STATE_INVALID");
    expect(res.body.error.details.allowedFrom).toEqual(["PLANNING"]);
  });
});

/* ══ 18-20. NOTHING IS BOOKED, ALLOCATED OR RELEASED ═════════════════════ */

describe("no capacity, no line, no Production and no Store write", () => {
  const read = (p) => fs.readFileSync(path.join(__dirname, "..", "..", p), "utf8");

  test("every answer says so on its face", async () => {
    const w = await readyWorld("SaysSo");
    const created = await createPlan(w);
    for (const body of [created.body]) {
      expect(body.planningFile.booksCapacity).toBe(false);
      expect(body.planningFile.allocatesLine).toBe(false);
      expect(body.planningFile.releasesProduction).toBe(false);
    }
  });

  test("marking PLANNED books nothing and writes nothing outside PPC", async () => {
    const w = await readyWorld("PlannedWrites");
    const created = await createPlan(w);
    const id = created.body.planningFile.planningFileId;

    /* Snapshot every collection this must not touch. */
    const snap = async () => ({
      files: await ExecutionFile.find({ companyId: w.co._id }).lean(),
      packs: await ExecutionPack.find({ companyId: w.co._id }).lean(),
      minutes: await PreProductionMeeting.find({ companyId: w.co._id }).lean(),
      releases: await IeRelease.find({ companyId: w.co._id }).lean(),
      status: await DepartmentStatusProjection.find({ companyId: w.co._id }).lean(),
    });
    const before = await snap();

    const started = await ppc(`/planning-files/${id}/planning-started`, {
      method: "POST", token: w.planner.token, company: w.co._id,
      body: { expectedRevision: 1 }, key: nextKey(),
    });
    const planned = await ppc(`/planning-files/${id}/planned`, {
      method: "POST", token: w.approver.token, company: w.co._id,
      body: { expectedRevision: started.body.planningFile.revision }, key: nextKey(),
    });
    expect(planned.status).toBe(200);
    expect(planned.body.planningFile.state).toBe("PLANNED");

    expect(JSON.stringify(await snap())).toBe(JSON.stringify(before));

    /* And no work order, production or stock collection came into existence. */
    const names = (await mongoose.connection.db.listCollections().toArray())
      .map((c) => c.name);
    const written = [];
    for (const n of names) {
      /* `merchandising_pre_production_meetings` legitimately holds the
         seeded minutes — the word "production" in another department's
         collection name is not a Production write, and the snapshot above
         already proves PPC did not touch it. */
      if (/^merchandising_/.test(n)) continue;
      if (!/workorder|production|stock|barcode|scan|capacity|lineplan/i.test(n)) continue;
      if (await mongoose.connection.collection(n).countDocuments({})) written.push(n);
    }
    expect(written).toEqual([]);
  });

  test("the model has no field that could hold a booking, and the service reaches nothing that could", () => {
    const paths = Object.keys(PpcPlanningFile.schema.paths).join(" ");
    for (const forbidden of [
      "lineId", "shiftId", "bookedMinutes", "dailyTarget",
      "productionReleaseNo", "workOrderId", "capacity",
    ]) {
      expect(paths).not.toMatch(new RegExp(forbidden, "i"));
    }

    for (const file of [
      "services/ppc/planningFile.service.js",
      "services/ppc/orderBook.service.js",
      "routes/CMS_Routes/PPC/orderBookRoute.js",
    ]) {
      const src = read(file);
      /* Requiring a Production, Store or capacity module is the thing that
         must not exist — matched as a require, not as prose. */
      expect(src).not.toMatch(/require\([^)]*WorkOrder[^)]*\)/);
      expect(src).not.toMatch(/require\([^)]*Production[^)]*\)/);
      expect(src).not.toMatch(/require\([^)]*StockItem[^)]*\)/);
      expect(src).not.toMatch(/require\([^)]*[Bb]arcode[^)]*\)/);
    }
  });

  test("the router allocates no line and releases nothing to Production", () => {
    const router = require("../../routes/CMS_Routes/PPC/orderBookRoute");
    const paths = router.stack.filter((l) => l.route).map((l) => l.route.path);
    const segments = paths.flatMap((p) => p.split("/").filter(Boolean));
    /* Allocating a sewing line, releasing work to Production and reaching a
       WorkOrder are still not PPC's, and none of them has a verb here. */
    expect(segments.filter((s) => /^(allocate|allocation|line-plan|lines?|releases|work-orders?|production)$/i
      .test(s))).toEqual([]);

    /* RESERVING CUTTING CAPACITY IS. It is PPC's own decision — which table,
       which days — and it is the only thing `book` and `release` may mean
       here, so every one of them is checked to be a cutting-capacity path
       rather than a Production verb that slipped in under the same word. */
    const verbs = paths.filter((p) => /\/(book|release|replan)$/.test(p));
    expect(verbs.sort()).toEqual([
      "/cutting-bookings/:bookingId/release",
      "/cutting-bookings/:bookingId/replan",
      "/planning-files/:planningFileId/cutting-capacity/book",
    ]);
    /* And nothing releases a quantity, only a reservation. */
    expect(segments.filter((s) => /^(capacity|bookings?)$/i.test(s))).toEqual([]);
  });

  test("PPC writes nothing back into Merchandising or IE from this slice", () => {
    for (const file of [
      "services/ppc/planningFile.service.js",
      "services/ppc/orderBook.service.js",
      "services/merchandising/planningPublication.service.js",
      "services/industrialEngineering/releasePublication.service.js",
    ]) {
      const src = read(file);
      for (const model of ["ExecutionFile", "ExecutionPack", "PreProductionMeeting",
        "IeRelease", "DepartmentStatusProjection"]) {
        /* Reads are the whole mechanism. WRITES are what must not exist. */
        expect(src).not.toMatch(
          new RegExp(`${model}\\.(create|updateOne|updateMany|findOneAndUpdate|findByIdAndUpdate|deleteOne|deleteMany|bulkWrite|insertMany)\\b`),
        );
      }
    }
  });
});

/* ══ 21. NO CONFIDENTIAL COMMERCIAL DATA ═════════════════════════════════ */

describe("no confidential commercial data reaches PPC", () => {
  test("not in the register, the detail, or the planning file", async () => {
    const w = await readyWorld("Confidential");
    /* Something writes commercial fields into the projection — a bad merge, a
       future helper. Strict mode should refuse them, and PPC must not carry
       them even if they were somehow stored. */
    await ExecutionFile.collection.updateOne(
      { _id: w.file._id },
      {
        $set: {
          "currentExecutionProjection.unitPrice": 12.5,
          "currentExecutionProjection.margin": 0.42,
          "currentExecutionProjection.supplierPrice": 9,
        },
      },
    );
    const created = await createPlan(w);
    const reg = await ppc("/order-book?view=all", { token: w.viewer.token, company: w.co._id });
    const detail = await ppc(`/order-book/${w.lineRef}`,
      { token: w.viewer.token, company: w.co._id });

    for (const payload of [reg.body, detail.body, created.body]) {
      const wire = JSON.stringify(payload);
      for (const forbidden of ["unitPrice", "margin", "markup", "supplierPrice",
        "price", "cost", "currency", "paymentTerm", "creditLimit", "quotation"]) {
        expect(wire.toLowerCase()).not.toContain(`"${forbidden.toLowerCase()}"`);
      }
      expect(wire).not.toContain("12.5");
      expect(wire).not.toContain("0.42");
    }
  });

  test("and no IE integrity hash crosses either", async () => {
    const w = await readyWorld("NoHash");
    const created = await createPlan(w);
    const stored = await IeRelease.findById(w.rel._id).lean();
    const wire = JSON.stringify(created.body);
    expect(wire).not.toContain(stored.aggregateFingerprint);
    expect(wire).not.toContain(stored.source.sourceFingerprint);
    expect(wire.toLowerCase()).not.toMatch(/fingerprint|digest/);
  });

  test("the published contracts carry no pack contents or minutes text", async () => {
    const w = await readyWorld("Contents");
    const merchPub = require("../../services/merchandising/planningPublication.service");
    const packs = await merchPub.publishCurrentExecutionPacks(
      { companyId: w.co._id }, [String(w.file._id)]);
    const published = packs.get(String(w.file._id));
    expect(published.packVersionNo).toBe(1);
    /* Identity and state only. */
    expect(Object.keys(published).sort()).toEqual([
      "allGatesPassed", "executionFileId", "packId", "packVersionNo",
      "state", "submittedAt", "supersededByPackVersionNo", "supersedesPackVersionNo",
    ]);
  });
});

/* ══ 22-24. THE ACCEPTED APPLICATIONS STAY AS THEY WERE ══════════════════ */

describe("the applications this slice reads are unchanged", () => {
  const read = (p) => fs.readFileSync(path.join(__dirname, "..", "..", p), "utf8");

  test("PPM minutes remain immutable — this slice adds no write path to them", () => {
    const src = read("services/merchandising/planningPublication.service.js");
    expect(src).toMatch(/PreProductionMeeting\.find\(/);
    expect(src).not.toMatch(/PreProductionMeeting\.(create|updateOne|findOneAndUpdate|deleteOne)/);
  });

  test("the publication contracts only ever read", () => {
    for (const file of [
      "services/merchandising/planningPublication.service.js",
      "services/industrialEngineering/releasePublication.service.js",
    ]) {
      const src = read(file);
      expect(src).not.toMatch(/\.(create|insertMany|bulkWrite|updateOne|updateMany|deleteOne|deleteMany|findOneAndUpdate|findOneAndDelete)\(/);
    }
  });

  test("the IE release acknowledgement surface is untouched by this slice", () => {
    /* The order book reads releases through IE's OWN published contract, not by
       reaching into PPC's inbound-queue service — so the accepted flow cannot
       be changed by a planning change. */
    const src = read("services/ppc/orderBook.service.js");
    expect(src).not.toMatch(/ieReleaseAck/);
    expect(src).toMatch(/releasePublication\.service|industrialEngineering\/releasePublication/);
  });

  test("PPC's existing two routers are still mounted beside the new one", () => {
    const src = read("server.js");
    for (const r of ["PPC/inboundPacksRoute", "PPC/ieReleasesRoute", "PPC/orderBookRoute"]) {
      expect(src).toContain(r);
    }
  });
});

/* ══ THE REGISTER'S OWN MECHANICS ════════════════════════════════════════ */

describe("views, counts, search and paging", () => {
  test("every count opens exactly the rows behind it", async () => {
    const co = await company("Counts");
    const viewer = await actor({ companies: [co], grants: { ppc: "viewer" } });
    const planner = await actor({ companies: [co], grants: { ppc: "editor" } });

    /* Two bare lines, one ready line. */
    await orderLine(co, { lineRef: "C-BARE-1" });
    await orderLine(co, { lineRef: "C-BARE-2" });
    const ready = await orderLine(co, { lineRef: "C-READY-1" });
    await pack(co, ready);
    await release(co, ready.currentExecutionProjection.sampleStyleId);
    await minutes(co, ready);

    const summary = await ppc("/order-book/summary", { token: viewer.token, company: co._id });
    expect(summary.status).toBe(200);
    expect(summary.body.counts.all).toBe(3);
    expect(summary.body.counts["awaiting-inputs"]).toBe(2);
    expect(summary.body.counts["ready-to-plan"]).toBe(1);

    /* Each count's own view returns exactly that many rows. */
    for (const [view, n] of Object.entries(summary.body.counts)) {
      const reg = await ppc(`/order-book?view=${view}&limit=100`,
        { token: viewer.token, company: co._id });
      expect(reg.body.rows).toHaveLength(n);
    }

    /* Planning one moves it between views, and the counts follow. */
    const created = await ppc("/order-book/C-READY-1/planning-file", {
      method: "POST", token: planner.token, company: co._id, body: {}, key: nextKey(),
    });
    expect(created.status).toBe(201);
    const after = await ppc("/order-book/summary", { token: viewer.token, company: co._id });
    expect(after.body.counts["ready-to-plan"]).toBe(0);
    expect(after.body.counts.planning).toBe(1);
  });

  test("search and paging are the server's, and a page never skips a row", async () => {
    const co = await company("Paging");
    const viewer = await actor({ companies: [co], grants: { ppc: "viewer" } });
    for (let i = 0; i < 7; i += 1) {
      await orderLine(co, { lineRef: `P-LINE-${i}`, orderRef: `ORD-P-${i}` });
    }
    await orderLine(co, { lineRef: "P-ODD-9", orderRef: "ORD-ODD", styleName: "Hoodie" });

    /* Search is applied server-side, over references and labels. */
    const found = await ppc("/order-book?view=all&search=Hoodie&limit=50",
      { token: viewer.token, company: co._id });
    expect(found.body.rows.map((r) => r.orderLineRef)).toEqual(["P-ODD-9"]);

    /* Walking the cursor sees all eight exactly once. */
    const seen = [];
    let cursor = "";
    for (let guard = 0; guard < 20; guard += 1) {
      const page = await ppc(`/order-book?view=all&limit=3&cursor=${cursor}`,
        { token: viewer.token, company: co._id });
      expect(page.status).toBe(200);
      seen.push(...page.body.rows.map((r) => r.orderLineRef));
      if (!page.body.nextCursor) break;
      cursor = page.body.nextCursor;
    }
    expect(seen).toHaveLength(8);
    expect(new Set(seen).size).toBe(8);
  });

  test("an unusable view or limit is a typed refusal, never a 500 and never a silent correction", async () => {
    const w = await readyWorld("BadInput");
    const bad = await ppc("/order-book?view=whatever",
      { token: w.viewer.token, company: w.co._id });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("PPC_ORDER_BOOK_VIEW_UNKNOWN");
    expect(bad.body.error.details.allowed).toContain("ready-to-plan");

    const badLimit = await ppc("/order-book?view=all&limit=-3",
      { token: w.viewer.token, company: w.co._id });
    expect(badLimit.status).toBe(400);
    expect(badLimit.body.error.code).toBe("PPC_ORDER_BOOK_LIMIT_INVALID");

    /* A limit above the cap is capped and SAYS it was capped. */
    const capped = await ppc("/order-book?view=all&limit=5000",
      { token: w.viewer.token, company: w.co._id });
    expect(capped.status).toBe(200);
    expect(capped.body.limit).toBe(100);
    expect(capped.body.maxLimit).toBe(100);
  });
});

/* ══ THE PLANNING FIELDS AND THE TRAIL ═══════════════════════════════════ */

describe("PPC's own planning fields, and the bounded trail", () => {
  test("each field round-trips, and a bad one is refused by name", async () => {
    const w = await readyWorld("Fields");
    const created = await createPlan(w);
    const id = created.body.planningFile.planningFileId;

    const ok = await ppc(`/planning-files/${id}`, {
      method: "PATCH", token: w.planner.token, company: w.co._id,
      body: {
        expectedRevision: 1,
        owner: "me",
        priority: "CRITICAL",
        proposedFactoryRef: "UNIT-3",
        planningNote: "Two lines, split across the October window.",
        riskNote: "Trim delivery is the constraint.",
        requestedProductionStart: "2026-10-05",
        requestedProductionEnd: "2026-10-26",
        requestedCompletionDate: "2026-10-30",
        assumptions: [
          { key: "efficiency", statement: "Planned at the ramp stage, not steady state." },
          { key: "shifts", statement: "Two shifts, six days." },
        ],
      },
    });
    expect(ok.status).toBe(200);
    const p = ok.body.planningFile.planning;
    expect(p.priority).toBe("CRITICAL");
    expect(p.proposedFactoryRef).toBe("UNIT-3");
    expect(p.owner.name).toBe(w.planner.name);
    expect(p.assumptions).toHaveLength(2);
    expect(p.requestedProductionStart).toMatch(/^2026-10-05/);

    /* An unknown priority is refused with the list. */
    const badPriority = await ppc(`/planning-files/${id}`, {
      method: "PATCH", token: w.planner.token, company: w.co._id,
      body: { expectedRevision: ok.body.planningFile.revision, priority: "URGENT" },
    });
    expect(badPriority.status).toBe(400);
    expect(badPriority.body.error.code).toBe("PPC_PLANNING_PRIORITY_INVALID");

    /* A window that ends before it starts is refused, naming both fields. */
    const badWindow = await ppc(`/planning-files/${id}`, {
      method: "PATCH", token: w.planner.token, company: w.co._id,
      body: {
        expectedRevision: ok.body.planningFile.revision,
        requestedProductionStart: "2026-11-01", requestedProductionEnd: "2026-10-01",
      },
    });
    expect(badWindow.status).toBe(400);
    expect(badWindow.body.error.code).toBe("PPC_PLANNING_WINDOW_INVALID");

    /* Two assumptions with one key would let one silently win. */
    const dupe = await ppc(`/planning-files/${id}`, {
      method: "PATCH", token: w.planner.token, company: w.co._id,
      body: {
        expectedRevision: ok.body.planningFile.revision,
        assumptions: [{ key: "k", statement: "one" }, { key: "k", statement: "two" }],
      },
    });
    expect(dupe.status).toBe(400);
    expect(dupe.body.error.code).toBe("PPC_PLANNING_ASSUMPTIONS_INVALID");
  });

  test("an empty edit is a no-op rather than a revision bump", async () => {
    const w = await readyWorld("NoOp");
    const created = await createPlan(w);
    const res = await ppc(`/planning-files/${created.body.planningFile.planningFileId}`, {
      method: "PATCH", token: w.planner.token, company: w.co._id,
      body: { expectedRevision: 1 },
    });
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(false);
    expect(res.body.planningFile.revision).toBe(1);
  });

  test("the trail names what changed without copying the values, and is bounded", async () => {
    const w = await readyWorld("Trail");
    const created = await createPlan(w);
    const id = created.body.planningFile.planningFileId;
    await ppc(`/planning-files/${id}`, {
      method: "PATCH", token: w.planner.token, company: w.co._id,
      body: { expectedRevision: 1, planningNote: "A note with SENSITIVE-TOKEN in it." },
    });

    const hist = await ppc(`/planning-files/${id}/history`,
      { token: w.viewer.token, company: w.co._id });
    expect(hist.status).toBe(200);
    expect(hist.body.events[0].type).toBe("PLANNING_FIELDS_UPDATED");
    expect(hist.body.events[0].changed).toEqual(["planningNote"]);
    /* The name, never the value. */
    expect(JSON.stringify(hist.body)).not.toContain("SENSITIVE-TOKEN");
    expect(hist.body.bounded).toBe(200);

    /* And the creation event is there, at the bottom. */
    expect(hist.body.events.map((e) => e.type)).toContain("PLANNING_FILE_CREATED");
  });

  test("a hold needs a classified reason, and OTHER needs a note", async () => {
    const w = await readyWorld("HoldReason");
    const created = await createPlan(w);
    const id = created.body.planningFile.planningFileId;

    const bad = await ppc(`/planning-files/${id}/hold`, {
      method: "POST", token: w.approver.token, company: w.co._id,
      body: { expectedRevision: 1, reason: "BECAUSE" }, key: nextKey(),
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("PPC_HOLD_REASON_INVALID");
    expect(bad.body.error.details.allowed).toContain("AWAITING_MATERIAL");

    const bareOther = await ppc(`/planning-files/${id}/hold`, {
      method: "POST", token: w.approver.token, company: w.co._id,
      body: { expectedRevision: 1, reason: "OTHER" }, key: nextKey(),
    });
    expect(bareOther.status).toBe(400);

    const ok = await ppc(`/planning-files/${id}/hold`, {
      method: "POST", token: w.approver.token, company: w.co._id,
      body: { expectedRevision: 1, reason: "AWAITING_MATERIAL", note: "Fabric short by 200m." },
      key: nextKey(),
    });
    expect(ok.status).toBe(200);
    expect(ok.body.planningFile.state).toBe("ON_HOLD");
    expect(ok.body.planningFile.holdReason).toBe("AWAITING_MATERIAL");
    /* A held line is in the blocked view. */
    const reg = await ppc("/order-book?view=blocked", { token: w.viewer.token, company: w.co._id });
    expect(reg.body.rows.map((r) => r.orderLineRef)).toContain(w.lineRef);
  });

  test("a closed plan cannot be edited", async () => {
    const w = await readyWorld("Closed");
    const created = await createPlan(w);
    const id = created.body.planningFile.planningFileId;
    /* The model refuses an unconditional state write, so the closed state is
       put there through the raw collection — standing in for a successor. */
    await mongoose.connection.collection("ppc_planning_files").updateOne(
      { _id: new mongoose.Types.ObjectId(id) }, { $set: { state: PLANNING_STATE.SUPERSEDED } },
    );

    const res = await ppc(`/planning-files/${id}`, {
      method: "PATCH", token: w.planner.token, company: w.co._id,
      body: { expectedRevision: 1, priority: "LOW" },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("PPC_PLANNING_FILE_CLOSED");
  });
});

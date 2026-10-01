// test/ppc/ppc-sales-process-requirement.integration.test.js
//
// SALES → MERCHANDISING → PPC: THE LINE'S PROCESS REQUIREMENT, END TO END.
//
// Every hop through its real door, in one isolated in-memory database:
//   Sales issues the handover for each exact lineRef (with the buyer's
//   approved PO as evidence) → Merchandising accepts it → the execution pack
//   PPC froze names that exact version → PPC proves the frozen IE route
//   against the line's statement.
//
// Pinned:
//   · two lines of one style, one style route: the embroidered line is
//     proven and schedulable; the plain, washed line is a named mismatch —
//     PPC neither picks nor edits a route;
//   · PPC reads ONLY the version its plan froze: a successor issued later
//     (the buyer adds a wash) does not change what the plan reads, and the
//     saved schedule stays readable while replanning waits for a successor;
//   · a legacy version with no statement is readable and unproven;
//   · stored statements that are incomplete — missing, duplicated, UNKNOWN,
//     a definite answer with no evidence — read as not stated; a required
//     OTHER process is unmatchable;
//   · another company's handover is never evidence.
"use strict";

/* IE's approved cutting standard. A required CUTTING stage carries one, or it
   cannot be dated — see test/ppc/ppc-cutting-technical-basis.test.js. */
const CUT_STD = require("./planningFixtures").cuttingStandard();
process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const crypto = require("crypto");
const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const Employee = require("../../models/Employee");
const DeptUser = require("../../models/Access/DeptUser");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const SalesJourney = require("../../models/CMS_Models/Sales/SalesJourney");
const Enquiry = require("../../models/CMS_Models/Sales/Enquiry");
const Account = require("../../models/CMS_Models/Sales/Account");
const SampleStyle = require("../../models/CMS_Models/Sales/SampleStyle");
const CustomerRequest = require("../../models/Customer_Models/CustomerRequest");
const ExecutionFile = require("../../models/CMS_Models/Merchandising/ExecutionFile");
const { PpcPlanningFile } = require("../../models/CMS_Models/PPC/PpcPlanningFile");
const { PpcPlanningCommand } = require("../../models/CMS_Models/PPC/PpcPlanningCommand");
const { PpcStageSchedule } = require("../../models/CMS_Models/PPC/PpcStageSchedule");
const { readStatement } = require("../../services/ppc/lineProcessRequirements");
const {
  nextKey, company, pack, minutes, release, readyWorld, SalesHandoverVersion,
} = require("./planningFixtures");

let http, base, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/cms/sales/merchandising-handovers", require("../../routes/CMS_Routes/Sales/merchandisingHandovers"));
  app.use("/api/cms/merchandising", require("../../routes/CMS_Routes/Merchandising/executionRoute"));
  app.use("/api/cms/ppc", require("../../routes/CMS_Routes/PPC/orderBookRoute"));
  await new Promise((r) => { http = app.listen(0, r); });
  base = `http://127.0.0.1:${http.address().port}/api/cms`;
  await PpcPlanningFile.syncIndexes();
  await PpcPlanningCommand.syncIndexes();
  await PpcStageSchedule.syncIndexes();
});
afterAll(async () => { await new Promise((r) => http.close(r)); });

const call = (path, { token, method = "GET", body, company: co, key } = {}) => fetch(`${base}${path}`, {
  method,
  headers: {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(co ? { "X-Costing-Company": String(co) } : {}),
    ...(key ? { "Idempotency-Key": key } : {}),
  },
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
}).then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

async function person(co, role, grants) {
  const n = ++seq;
  const email = `spr${n}-${Date.now()}@grav.test`;
  const emp = await Employee.create({ firstName: "S", lastName: `P${n}`, email, biometricId: `SPR${n}${Date.now()}`, isActive: true, gender: "Other", department: "Ops" });
  await DeptUser.create({ name: "User", email, passwordHash: "x", isAdmin: false, isActive: true, departmentId: new mongoose.Types.ObjectId(), employeeRef: emp._id });
  await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: emp._id, personName: "S" });
  for (const [departmentSlug, r] of Object.entries(grants)) {
    await DepartmentRole.create({ departmentSlug, email, name: "User", role: r, isActive: true, departmentId: new mongoose.Types.ObjectId() });
  }
  return { token: jwt.sign({ id: String(emp._id), email, name: `Person ${n}`, role, employeeId: emp.biometricId },
    process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" }) };
}

const id = () => `stg_${crypto.randomBytes(9).toString("hex")}`;
/** IE's approved style route: cut → embroider → sew; print and wash not applicable. */
function styleRoute() {
  const ids = { cut: id(), emb: id(), sew: id() };
  return { ids, stages: [
    { stageId: ids.cut, sequence: 1, process: "CUTTING", label: "Cutting", applicability: "REQUIRED", predecessorStageIds: [], technicalStandard: CUT_STD },
    { stageId: ids.emb, sequence: 2, process: "EMBROIDERY", label: "Chest logo", applicability: "REQUIRED", predecessorStageIds: [ids.cut] },
    { stageId: id(), sequence: 3, process: "PRINTING", label: "Printing", applicability: "NOT_APPLICABLE", predecessorStageIds: [] },
    { stageId: ids.sew, sequence: 4, process: "SEWING", label: "Sewing", applicability: "REQUIRED", predecessorStageIds: [ids.emb] },
    { stageId: id(), sequence: 5, process: "WASHING", label: "Washing", applicability: "NOT_APPLICABLE", predecessorStageIds: [] },
  ] };
}

/** A company, one confirmed order with two lines of one style, the buyer's PO, and its people. */
async function world(label) {
  const co = await company(label);
  const n = ++seq;
  const account = await Account.create({ companyId: co._id, companyName: `Northwind ${n}`, status: "active" });
  const journey = await SalesJourney.create({ journeyId: `SJ-${label}-${n}`, companyId: co._id, name: `J${n}`,
    accountId: account._id, ownerId: new mongoose.Types.ObjectId(), ownerName: "O" });
  const enquiry = await Enquiry.create({ enquiryId: `ENQ-${label}-${n}`, journeyId: journey._id, accountId: account._id,
    companyId: co._id, title: "E", isActive: true, products: [{ product: "Polo", quantity: 800 }] });
  const style = await SampleStyle.create({ sampleStyleId: `SS-${label}-${n}`, styleCode: `SC-${label}-${n}`,
    productName: `${label} polo`, journeyId: journey._id, enquiryId: enquiry._id, stage: "rnd", materials: { status: "selected", rawItems: [] } });
  const created = await CustomerRequest.create({
    requestId: `REQ-${label}-${n}`, status: "quotation_sales_approved", orderOrigin: "customer",
    customerInfo: { name: "Northwind Buying" },
    /* Two lines of one style, each identified by its own commercial
       product-line reference — the only thing a PO can be matched on. */
    items: [
      { stockItemName: "Polo", totalQuantity: 500, totalEstimatedPrice: 240, sampleStyleId: style._id, productLineRef: `PL-${n}-A` },
      { stockItemName: "Polo", totalQuantity: 300, totalEstimatedPrice: 240, sampleStyleId: style._id, productLineRef: `PL-${n}-B` },
    ],
    quotations: [{ quotationNumber: `Q-${n}`, status: "sales_approved", revision: 1, date: new Date("2026-08-25"),
      items: [{ sampleStyleId: style._id, productLineRef: `PL-${n}-A`, quantity: 500 },
        { sampleStyleId: style._id, productLineRef: `PL-${n}-B`, quantity: 300 }],
      customerApproval: { approved: true, approvedAt: new Date("2026-08-29") },
      poProof: { publicId: `grav/po/${n}`, name: "PO.pdf", poNumber: `PO-${n}`, poDate: new Date("2026-08-28"), uploadedAt: new Date("2026-08-28") } }],
  });
  const request = await CustomerRequest.findById(created._id).lean();
  const r = styleRoute();
  const rel = await release(co, style._id, { processRoute: r.stages });
  return {
    co, style, request, r, rel, lines: request.items.map((i) => String(i.lineRef)),
    evidenceRef: `BUYER_PO:${request.quotations[0]._id}:r1`,
    seller: await person(co, "sales", { sales: "approver" }),
    merch: await person(co, "employee", { merchandiser: "approver" }),
    planner: await person(co, "employee", { ppc: "editor" }),
  };
}

const statement = (w, { emb, prn = "NOT_REQUIRED", wash }) => ({ processes: [
  { process: "EMBROIDERY", requirement: emb, evidenceRef: w.evidenceRef, buyerSpecification: emb === "REQUIRED" ? "PO: left chest logo" : "PO: plain body" },
  { process: "PRINTING", requirement: prn, evidenceRef: w.evidenceRef, buyerSpecification: "PO: no print" },
  { process: "WASHING", requirement: wash, evidenceRef: w.evidenceRef, buyerSpecification: wash === "REQUIRED" ? "PO: enzyme wash" : "PO: no wash" },
] });

/** Sales issues → Merchandising accepts → pack + minutes → PPC opens a plan. */
async function handOver(w, index, processRequirements, { expected = 0 } = {}) {
  const lineRef = w.lines[index];
  const issued = await call(`/sales/merchandising-handovers/requests/${w.request._id}/lines/${lineRef}/issue`, {
    token: w.seller.token, method: "POST",
    body: { expectedCurrentVersionNo: expected, deliveries: [{ committedDeliveryDate: "2026-12-15", quantity: index === 0 ? 500 : 300 }],
      ...(processRequirements ? { processRequirements } : {}) },
  });
  expect(issued.status).toBe(201);
  const accepted = await call(`/merchandising/handovers/${issued.body.version._id}/accept`,
    { token: w.merch.token, company: w.co._id, method: "POST", body: {} });
  expect(accepted.status).toBe(201);
  return { lineRef, version: issued.body.version };
}
async function openPlan(w, lineRef) {
  const file = await ExecutionFile.findOne({ companyId: w.co._id, handoverLineRef: lineRef }).lean();
  await pack(w.co, file);
  await minutes(w.co, file);
  const c = await call(`/ppc/order-book/${lineRef}/planning-file`,
    { token: w.planner.token, company: w.co._id, method: "POST", body: {}, key: nextKey() });
  expect(c.status).toBe(201);
  return c.body.planningFile.planningFileId;
}
const schedule = (w, pf) => call(`/ppc/planning-files/${pf}/stage-schedule`, { token: w.planner.token, company: w.co._id });
const save = (w, pf, body) => call(`/ppc/planning-files/${pf}/stage-schedule`,
  { token: w.planner.token, company: w.co._id, method: "POST", body, key: nextKey() });

/* ══ THE WHOLE PATH ═══════════════════════════════════════════════════════ */

describe("two lines of one style, through Sales, Merchandising and PPC", () => {
  test("the embroidered line is proven and schedulable; the plain, washed line is a named mismatch", async () => {
    const w = await world("SprTwin");
    const a = await handOver(w, 0, statement(w, { emb: "REQUIRED", wash: "NOT_REQUIRED" }));
    const b = await handOver(w, 1, statement(w, { emb: "NOT_REQUIRED", wash: "REQUIRED" }));
    const pfA = await openPlan(w, a.lineRef);
    const pfB = await openPlan(w, b.lineRef);

    const ra = await schedule(w, pfA);
    expect(ra.status).toBe(200);
    expect(ra.body.applicability).toMatchObject({ state: "PROVEN", reason: null });
    expect(ra.body.applicability.evidence.requirementVersion).toMatchObject({ versionId: String(a.version._id), versionNo: 1, handoverLineRef: a.lineRef });
    expect(ra.body.stages.map((s) => s.process)).toEqual(["CUTTING", "EMBROIDERY", "SEWING"]);
    /* The EMBROIDERY stage, because a cutting window is reserved rather than
       typed. What is being proved is that this line may be dated at all. */
    const saved = await save(w, pfA, { expectedRevision: 0, stages: [{ stageId: w.r.ids.emb, plannedStart: "2026-10-01", plannedEnd: "2026-10-03" }] });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ planningTargetsOnly: true, publishedToOtherApps: false, booksCapacity: false, releasesProduction: false });

    const rb = await schedule(w, pfB);
    expect(rb.body.applicability).toMatchObject({ state: "BLOCKED", reason: "REQUIREMENT_ROUTE_MISMATCH", owner: "Industrial Engineering" });
    expect(rb.body.applicability.processes.filter((p) => p.verdict === "MISMATCH").map((p) => [p.process, p.line, p.route])).toEqual([
      ["EMBROIDERY", "NOT_REQUIRED", "REQUIRED"], ["WASHING", "REQUIRED", "NOT_APPLICABLE"],
    ]);
    expect(rb.body.stages).toEqual([]);
    const refused = await save(w, pfB, { expectedRevision: 0, stages: [{ stageId: w.r.ids.cut, plannedStart: "2026-10-01", plannedEnd: "2026-10-03" }] });
    expect(refused.status).toBe(409);
    expect(refused.body.error.details.reason).toBe("REQUIREMENT_ROUTE_MISMATCH");
    /* PPC chose nothing and changed nothing on IE's side. */
    const IeRelease = require("../../models/CMS_Models/IndustrialEngineering/IeRelease");
    const relNow = await IeRelease.findById(w.rel.release._id).lean();
    expect(relNow.source.processRoute.stages.map((x) => [x.stageId, x.applicability]))
      .toEqual(w.r.stages.map((x) => [x.stageId, x.applicability]));
    expect(await PpcStageSchedule.countDocuments({ planningFileId: new mongoose.Types.ObjectId(pfB) })).toBe(0);
  });

  test("PPC reads only the version its plan froze: a later buyer change does not reach the plan", async () => {
    const w = await world("SprFrozen");
    const v1 = await handOver(w, 0, statement(w, { emb: "REQUIRED", wash: "NOT_REQUIRED" }));
    const pf = await openPlan(w, v1.lineRef);
    expect((await save(w, pf, { expectedRevision: 0, stages: [{ stageId: w.r.ids.emb, plannedStart: "2026-10-01", plannedEnd: "2026-10-03" }] })).status).toBe(200);

    /* The buyer adds a wash: Sales issues v2, Merchandising accepts it. */
    const v2 = await handOver(w, 0, statement(w, { emb: "REQUIRED", wash: "REQUIRED" }), { expected: 1 });
    expect(v2.version.versionNo).toBe(2);
    const file = await ExecutionFile.findOne({ handoverLineRef: v1.lineRef }).lean();
    expect(String(file.currentHandoverVersionId)).toBe(String(v2.version._id));

    const res = await schedule(w, pf);
    /* Still v1 — the one the frozen pack names — and never v2's wash. */
    expect(res.body.applicability.evidence.requirementVersion).toMatchObject({ versionId: String(v1.version._id), versionNo: 1, publicationState: "SUPERSEDED" });
    expect(res.body.applicability.reason).toBe("REQUIREMENT_SUPERSEDED");
    expect(res.body.stages.find((x) => x.process === "EMBROIDERY"))
      .toMatchObject({ plannedStart: "2026-10-01" });
    expect(res.body.history).toHaveLength(1);
    expect(res.body.editable).toBe(false);
    /* And v1's own statement is untouched. */
    const frozen = await SalesHandoverVersion.findById(v1.version._id).lean();
    expect(readStatement(frozen)).toMatchObject({ state: "STATED", processes: { EMBROIDERY: "REQUIRED", PRINTING: "NOT_REQUIRED", WASHING: "NOT_REQUIRED" } });
  });

  test("a legacy version with no statement is readable and unproven", async () => {
    const w = await world("SprLegacy");
    const v = await handOver(w, 0, null);
    const res = await schedule(w, await openPlan(w, v.lineRef));
    expect(res.status).toBe(200);
    expect(res.body.applicability).toMatchObject({ state: "BLOCKED", reason: "LINE_REQUIREMENT_NOT_STATED", owner: "Sales" });
    expect(res.body.applicability.message).toMatch(/does not state whether it needs embroidery, printing or washing/);
  });

  test("Sales' UNKNOWN reaches PPC as not stated, named per process", async () => {
    const w = await world("SprUnknown");
    const s = statement(w, { emb: "REQUIRED", wash: "NOT_REQUIRED" });
    s.processes[2] = { process: "WASHING", requirement: "UNKNOWN" };
    const v = await handOver(w, 0, s);
    const res = await schedule(w, await openPlan(w, v.lineRef));
    expect(res.body.applicability.reason).toBe("LINE_REQUIREMENT_NOT_STATED");
    expect(res.body.applicability.message).toMatch(/washing is stated as unknown/);
  });

  test("a required OTHER process reaches PPC as unmatchable", async () => {
    const w = await world("SprOther");
    const s = statement(w, { emb: "REQUIRED", wash: "NOT_REQUIRED" });
    s.processes.push({ process: "OTHER", otherLabel: "Gold foil", requirement: "REQUIRED", evidenceRef: w.evidenceRef, buyerSpecification: "PO: foil on sleeve" });
    const v = await handOver(w, 0, s);
    const pf = await openPlan(w, v.lineRef);
    const res = await schedule(w, pf);
    expect(res.body.applicability).toMatchObject({ state: "BLOCKED", reason: "LINE_PROCESS_UNMATCHABLE", owner: "Sales" });
    expect(res.body.applicability.message).toMatch(/"Gold foil"/);
    const refused = await save(w, pf, { expectedRevision: 0, stages: [{ stageId: w.r.ids.cut, plannedStart: "2026-10-01", plannedEnd: "2026-10-03" }] });
    expect(refused.body.error.details).toMatchObject({ reason: "LINE_PROCESS_UNMATCHABLE", unmatchable: ["Gold foil"] });
  });
});

/* ══ THE READER, AGAINST WHAT IS ACTUALLY STORED ══════════════════════════ */

describe("PPC's reader fails closed on a stored statement, whoever wrote it", () => {
  const evidence = { kind: "BUYER_PO", buyerApprovalRef: "q1", documentRef: "grav/po/1" };
  const good = (process, requirement) => ({ process, requirement, buyerSpecification: "PO", evidence });
  const v = (processes) => ({ executionProjection: { processRequirements: { statedAt: new Date(), processes } } });
  const full = [good("EMBROIDERY", "REQUIRED"), good("PRINTING", "NOT_REQUIRED"), good("WASHING", "NOT_REQUIRED")];

  test("all three stated with evidence", () => {
    expect(readStatement(v(full))).toMatchObject({ state: "STATED", processes: { EMBROIDERY: "REQUIRED", PRINTING: "NOT_REQUIRED", WASHING: "NOT_REQUIRED" } });
  });
  test("absent field: not stated (legacy)", () => {
    expect(readStatement({ executionProjection: {} })).toMatchObject({ state: "NOT_STATED", processes: null });
  });
  test.each([
    ["missing", [full[0], full[1]], "WASHING", "MISSING"],
    ["duplicate, even when both agree", [...full, good("WASHING", "NOT_REQUIRED")], "WASHING", "DUPLICATE"],
    ["UNKNOWN", [full[0], full[1], { process: "WASHING", requirement: "UNKNOWN" }], "WASHING", "UNKNOWN"],
    ["NOT_REQUIRED without evidence", [full[0], full[1], { process: "WASHING", requirement: "NOT_REQUIRED", buyerSpecification: "no wash" }], "WASHING", "NO_EVIDENCE"],
    ["REQUIRED without a document", [{ ...full[0], evidence: { kind: "BUYER_PO", buyerApprovalRef: "q1" } }, full[1], full[2]], "EMBROIDERY", "NO_EVIDENCE"],
    ["definite without a buyer specification", [{ ...full[0], buyerSpecification: "" }, full[1], full[2]], "EMBROIDERY", "NO_EVIDENCE"],
  ])("%s: not stated, and the other processes still read", (_n, processes, process, why) => {
    const out = readStatement(v(processes));
    expect(out.state).toBe("NOT_STATED");
    expect(out.problems).toEqual([{ process, why }]);
    expect(out.processes[process]).toBeUndefined();
  });
  test("a company order's Sales authorisation reads as stated; without its reason it does not", () => {
    const authorised = { kind: "INTERNAL_ORDER", buyerApprovalRef: "q1", authorisedById: "actor1", reason: "Company uniform order." };
    const rows = [
      { process: "EMBROIDERY", requirement: "REQUIRED", buyerSpecification: "Chest logo", evidence: authorised },
      { process: "PRINTING", requirement: "NOT_REQUIRED", buyerSpecification: "None", evidence: authorised },
      { process: "WASHING", requirement: "NOT_REQUIRED", buyerSpecification: "None", evidence: authorised },
    ];
    expect(readStatement(v(rows))).toMatchObject({ state: "STATED", processes: { EMBROIDERY: "REQUIRED" } });
    const noReason = rows.map((r) => ({ ...r, evidence: { ...authorised, reason: "" } }));
    expect(readStatement(v(noReason))).toMatchObject({ state: "NOT_STATED" });
    const noActor = rows.map((r) => ({ ...r, evidence: { ...authorised, authorisedById: "" } }));
    expect(readStatement(v(noActor))).toMatchObject({ state: "NOT_STATED" });
  });

  test("a required OTHER is unmatchable; a not-required OTHER is harmless", () => {
    expect(readStatement(v([...full, { process: "OTHER", otherLabel: "Foil", requirement: "REQUIRED", buyerSpecification: "PO", evidence }])))
      .toMatchObject({ state: "UNMATCHABLE", unmatchable: ["Foil"] });
    expect(readStatement(v([...full, { process: "OTHER", otherLabel: "Foil", requirement: "NOT_REQUIRED", buyerSpecification: "PO", evidence }])).state)
      .toBe("STATED");
  });

  test("a stored duplicate reaches the PPC screen as not stated", async () => {
    const w = await readyWorld("SprStoredDup", { processRoute: styleRoute().stages });
    await SalesHandoverVersion.collection.updateOne({ _id: w.file.currentHandoverVersionId },
      { $set: { "executionProjection.processRequirements": { statedAt: new Date(), processes: [...full, good("EMBROIDERY", "NOT_REQUIRED")] } } });
    const c = await call(`/ppc/order-book/${w.lineRef}/planning-file`, { token: w.planner.token, company: w.co._id, method: "POST", body: {}, key: nextKey() });
    const res = await call(`/ppc/planning-files/${c.body.planningFile.planningFileId}/stage-schedule`, { token: w.planner.token, company: w.co._id });
    expect(res.body.applicability.reason).toBe("LINE_REQUIREMENT_NOT_STATED");
    expect(res.body.applicability.message).toMatch(/embroidery is stated more than once/);
  });
});

/* ══ COMPANY BOUNDARY ═════════════════════════════════════════════════════ */

describe("another company's handover is never evidence", () => {
  test("a pack pointing at another company's fully stated version reads as missing, and leaks nothing", async () => {
    const w = await world("SprIsoA");
    const theirs = await world("SprIsoB");
    const foreign = await handOver(theirs, 0, statement(theirs, { emb: "REQUIRED", wash: "NOT_REQUIRED" }));
    const mine = await handOver(w, 0, statement(w, { emb: "REQUIRED", wash: "NOT_REQUIRED" }));
    const pf = await openPlan(w, mine.lineRef);
    const plan = await PpcPlanningFile.findById(pf).lean();
    await mongoose.connection.collection("merchandising_execution_packs").updateOne(
      { _id: plan.sourceBasis.executionPackId }, { $set: { "contents.salesHandover.versionId": foreign.version._id } });
    const res = await schedule(w, pf);
    expect(res.body.applicability).toMatchObject({ state: "BLOCKED", reason: "REQUIREMENT_VERSION_MISSING" });
    expect(JSON.stringify(res.body)).not.toContain(String(foreign.version._id));
    expect(JSON.stringify(res.body)).not.toContain(theirs.lines[0]);
    /* And their planner cannot read ours at all. */
    const peek = await call(`/ppc/planning-files/${pf}/stage-schedule`, { token: theirs.planner.token, company: theirs.co._id });
    expect(peek.status).toBe(404);
  });
});

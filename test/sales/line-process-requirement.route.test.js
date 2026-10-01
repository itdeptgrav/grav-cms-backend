// test/sales/line-process-requirement.route.test.js
//
// SALES STATES WHAT THIS LINE'S BUYER APPROVED — EMBROIDERY, PRINTING, WASHING.
//
// Through the real Sales handover door, then the real Merchandising accept
// door. Pinned:
//
//   · Sales states each process for the EXACT permanent lineRef: two lines of
//     one style on one order carry different statements;
//   · a definite answer rests on a buyer approval the server finds on THIS
//     order — the customer-approved quotation with its uploaded PO — and the
//     version freezes that approval's identity, never its price;
//   · a definite answer without evidence, evidence from elsewhere, a missing
//     or duplicated process, an unlabelled OTHER, or an unexpected field is
//     refused; UNKNOWN is accepted and cites nothing;
//   · an order confirmed without the buyer's approval on file — Sales'
//     "without customer approval" push, or an internal order — can only say
//     UNKNOWN; a revised round's inherited PO, a stale reference from before
//     a revise, and a round that does not cover the line are not evidence;
//   · a version issued without a statement states nothing (legacy shape);
//   · a buyer change is a successor version — the old version keeps its own
//     statement, is frozen against in-place edits, and a successor may not
//     silently drop a stated requirement;
//   · Merchandising's accepted copy carries the statement exactly;
//   · another company's order is not found.
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
const CustomerRequest = require("../../models/Customer_Models/CustomerRequest");
const SalesHandoverVersion = require("../../models/CMS_Models/Sales/SalesHandoverVersion");
const ExecutionFile = require("../../models/CMS_Models/Merchandising/ExecutionFile");

let server, base, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/cms/sales/merchandising-handovers", require("../../routes/CMS_Routes/Sales/merchandisingHandovers"));
  app.use("/api/cms/merchandising", require("../../routes/CMS_Routes/Merchandising/executionRoute"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/cms`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

const call = (path, { token, method = "GET", body, company } = {}) => fetch(`${base}${path}`, {
  method,
  headers: {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(company ? { "X-Costing-Company": String(company) } : {}),
  },
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
}).then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

async function actor({ companies = [], role = "sales", grants = { sales: "approver" } } = {}) {
  const n = ++seq;
  const email = `lpr${n}@grav.test`;
  const emp = await Employee.create({
    firstName: "L", lastName: `P${n}`, email, biometricId: `LPR${n}`, isActive: true, gender: "Other", department: "Sales",
  });
  await DeptUser.create({
    name: "User", email, passwordHash: "x", isAdmin: false, isActive: true,
    departmentId: new mongoose.Types.ObjectId(), employeeRef: emp._id,
  });
  for (const co of companies) await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: emp._id, personName: "L" });
  for (const [departmentSlug, r] of Object.entries(grants)) {
    await DepartmentRole.create({ departmentSlug, email, name: "User", role: r, isActive: true, departmentId: new mongoose.Types.ObjectId() });
  }
  return {
    id: String(emp._id),
    token: jwt.sign({ id: String(emp._id), email, name: `Seller ${n}`, role, employeeId: emp.biometricId },
      process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" }),
  };
}

const PO = { publicId: "grav/po/northwind-4471", name: "Northwind PO 4471.pdf", poNumber: "NW-PO-4471",
  poDate: new Date("2026-08-28"), poValue: 1250000, uploadedAt: new Date("2026-08-28") };

/**
 * A confirmed order with TWO lines of ONE style, and — unless `approved` is
 * false — the buyer's approved quotation with its PO on file.
 */
async function world(label, { approved = true, quotations = null, quotationRevisions = [], isInternalOrder = false } = {}) {
  const n = ++seq;
  const co = await Acc_Company.create({ companyName: `${label} ${n}`, booksFromDate: new Date("2026-04-01") });
  const account = await Account.create({ companyId: co._id, companyName: `Northwind ${n}`, status: "active" });
  const journey = await SalesJourney.create({
    journeyId: `SJ-${label}-${n}`, companyId: co._id, name: `J${n}`,
    accountId: account._id, ownerId: new mongoose.Types.ObjectId(), ownerName: "O",
  });
  const enquiry = await Enquiry.create({
    enquiryId: `ENQ-${label}-${n}`, journeyId: journey._id, accountId: account._id, companyId: co._id,
    title: `Enquiry ${n}`, isActive: true,
    /* The enquiry's checkboxes say nothing about either line — and nothing reads them. */
    products: [{ product: "Polo", quantity: 800, embroidery: false, printing: false }],
  });
  const style = await SampleStyle.create({
    sampleStyleId: `SS-${label}-${n}`, styleCode: `SC-${label}-${n}`, productName: `${label} polo`,
    journeyId: journey._id, enquiryId: enquiry._id, stage: "rnd", materials: { status: "selected", rawItems: [] },
  });
  const request = await CustomerRequest.create({
    requestId: `REQ-${label}-${n}`, status: "quotation_sales_approved", orderOrigin: "customer",
    customerInfo: { name: `Northwind Buying ${n}` },
    /* Two lines of ONE style, each with its own commercial product-line
       reference — the only thing that tells them apart. */
    items: [
      { stockItemName: `${label} polo`, totalQuantity: 500, totalEstimatedPrice: 240, sampleStyleId: style._id, productLineRef: `PL-${n}-A` },
      { stockItemName: `${label} polo`, totalQuantity: 300, totalEstimatedPrice: 240, sampleStyleId: style._id, productLineRef: `PL-${n}-B` },
    ],
    quotations: quotations || (approved ? [{
      quotationNumber: `Q-${n}`, status: "sales_approved", revision: 2, date: new Date("2026-08-25"),
      items: [{ sampleStyleId: style._id, productLineRef: `PL-${n}-A`, quantity: 500 },
        { sampleStyleId: style._id, productLineRef: `PL-${n}-B`, quantity: 300 }],
      customerApproval: { approved: true, approvedAt: new Date("2026-08-29") }, poProof: PO,
    }] : [{ quotationNumber: `Q-${n}`, status: "sales_approved", revision: 1, customerApproval: { approved: false } }]),
    quotationRevisions,
    ...(isInternalOrder ? { isInternalOrder: true } : {}),
  });
  const saved = await CustomerRequest.findById(request._id).lean();
  const [a, b] = saved.items.map((i) => String(i.lineRef));
  const seller = await actor({ companies: [co] });
  const q0 = saved.quotations[0];
  const plr = (i) => `PL-${n}-${i === 0 ? "A" : "B"}`;
  return { co, style, n, plr, request: saved, lines: { a, b }, seller,
    evidenceRef: q0 ? `BUYER_PO:${q0._id}:r${q0.revision || 1}` : null };
}

const inspect = (w, who = w.seller) => call(`/sales/merchandising-handovers/requests/${w.request._id}`, { token: who.token });
const issue = (w, lineRef, body, who = w.seller) => call(
  `/sales/merchandising-handovers/requests/${w.request._id}/lines/${lineRef}/issue`,
  { token: who.token, method: "POST", body: { expectedCurrentVersionNo: 0, deliveries: [{ committedDeliveryDate: "2026-12-15", quantity: lineRef === w.lines.a ? 500 : 300 }], ...body } },
);
const row = (process, requirement, ev, spec) => ({
  process, requirement,
  ...(ev ? { evidenceRef: ev } : {}),
  ...(spec ? { buyerSpecification: spec } : {}),
});
const statement = (w, { emb = "REQUIRED", prn = "NOT_REQUIRED", wash = "NOT_REQUIRED" } = {}) => ({ processes: [
  row("EMBROIDERY", emb, emb === "UNKNOWN" ? null : w.evidenceRef, emb === "UNKNOWN" ? null : `PO line 1: ${emb === "REQUIRED" ? "left chest logo, 3 colours" : "no embroidery"}`),
  row("PRINTING", prn, prn === "UNKNOWN" ? null : w.evidenceRef, prn === "UNKNOWN" ? null : "PO: no print"),
  row("WASHING", wash, wash === "UNKNOWN" ? null : w.evidenceRef, wash === "UNKNOWN" ? null : `PO: ${wash === "REQUIRED" ? "enzyme wash" : "no wash"}`),
] });

/* ══ AUTHORING, PER EXACT LINE ════════════════════════════════════════════ */

describe("Sales states each process for the exact line, on the buyer's approval", () => {
  test("two lines of one style carry different statements, each with the order's PO frozen as evidence", async () => {
    const w = await world("LprTwin");
    const approvals = (await inspect(w)).body.lines[0].buyerApprovals;
    expect(approvals).toEqual([expect.objectContaining({
      evidenceRef: w.evidenceRef, label: "Buyer-approved order (PO)", approvalRevision: 2, poNumber: "NW-PO-4471",
    })]);
    expect(JSON.stringify(approvals)).not.toMatch(/1250000|poValue|price/i);

    const a = await issue(w, w.lines.a, { processRequirements: statement(w, { emb: "REQUIRED" }) });
    const b = await issue(w, w.lines.b, { processRequirements: statement(w, { emb: "NOT_REQUIRED", wash: "REQUIRED" }) });
    expect([a.status, b.status]).toEqual([201, 201]);

    const va = await SalesHandoverVersion.findById(a.body.version._id).lean();
    const vb = await SalesHandoverVersion.findById(b.body.version._id).lean();
    expect(va.handoverLineRef).toBe(w.lines.a);
    expect(vb.handoverLineRef).toBe(w.lines.b);
    expect(String(va.executionProjection.sampleStyleId)).toBe(String(vb.executionProjection.sampleStyleId));
    const by = (v) => Object.fromEntries(v.executionProjection.processRequirements.processes.map((p) => [p.process, p.requirement]));
    expect(by(va)).toEqual({ EMBROIDERY: "REQUIRED", PRINTING: "NOT_REQUIRED", WASHING: "NOT_REQUIRED" });
    expect(by(vb)).toEqual({ EMBROIDERY: "NOT_REQUIRED", PRINTING: "NOT_REQUIRED", WASHING: "REQUIRED" });

    const emb = va.executionProjection.processRequirements.processes[0];
    expect(emb.buyerSpecification).toBe("PO line 1: left chest logo, 3 colours");
    expect(emb.evidence).toMatchObject({
      kind: "BUYER_PO", buyerApprovalRef: String(w.request.quotations[0]._id), approvalRevision: 2,
      approvedAt: new Date("2026-08-29"), poNumber: "NW-PO-4471", poDate: new Date("2026-08-28"),
      documentRef: "grav/po/northwind-4471", documentName: "Northwind PO 4471.pdf",
    });
    expect(emb.evidence.authorisedById).toBeUndefined();
    expect(emb.evidence.reason).toBe("");
    expect(JSON.stringify(va.executionProjection)).not.toMatch(/1250000|poValue/);
    expect(va.executionProjection.processRequirements.statedBy.id.toString()).toBe(w.seller.id);

    /* Sales' own panel shows each line's statement. */
    const lines = (await inspect(w)).body.lines;
    const shown = lines.find((l) => l.lineRef === w.lines.b).currentVersion.processRequirements;
    expect(shown.processes.map((p) => [p.process, p.requirement, p.evidence?.label])).toEqual([
      ["EMBROIDERY", "NOT_REQUIRED", "Buyer-approved order (PO)"], ["PRINTING", "NOT_REQUIRED", "Buyer-approved order (PO)"],
      ["WASHING", "REQUIRED", "Buyer-approved order (PO)"],
    ]);
  });

  test("UNKNOWN is an accepted answer and cites nothing", async () => {
    const w = await world("LprUnknown");
    const res = await issue(w, w.lines.a, { processRequirements: statement(w, { emb: "UNKNOWN" }) });
    expect(res.status).toBe(201);
    const emb = res.body.version.executionProjection.processRequirements.processes[0];
    expect(emb).toMatchObject({ process: "EMBROIDERY", requirement: "UNKNOWN" });
    expect(emb.evidence).toBeUndefined();
  });

  test("an OTHER process needs a label, and is kept as stated", async () => {
    const w = await world("LprOther");
    const base = statement(w);
    const unlabelled = await issue(w, w.lines.a, { processRequirements: { processes: [...base.processes, row("OTHER", "REQUIRED", w.evidenceRef, "PO: foil")] } });
    expect(unlabelled.status).toBe(400);
    expect(unlabelled.body.error.details.field).toMatch(/otherLabel/);
    const ok = await issue(w, w.lines.a, { processRequirements: { processes: [...base.processes,
      { ...row("OTHER", "REQUIRED", w.evidenceRef, "PO: gold foil on sleeve"), otherLabel: "Foil print" }] } });
    expect(ok.status).toBe(201);
    expect(ok.body.version.executionProjection.processRequirements.processes[3]).toMatchObject({ process: "OTHER", otherLabel: "Foil print", requirement: "REQUIRED" });
  });
});

/* ══ REFUSED AT THE DOOR ══════════════════════════════════════════════════ */

describe("nothing becomes an answer it was not", () => {
  const refused = async (w, processRequirements, code = "VALIDATION") => {
    const res = await issue(w, w.lines.a, { processRequirements });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe(code);
    expect(await SalesHandoverVersion.countDocuments({ handoverLineRef: w.lines.a })).toBe(0);
    return res.body.error;
  };

  test("a definite answer without buyer evidence is refused, whichever way it points", async () => {
    const w = await world("LprNoEv");
    const s = statement(w);
    delete s.processes[1].evidenceRef; // PRINTING NOT_REQUIRED, on nobody's word
    const e = await refused(w, s, "PROCESS_REQUIREMENT_EVIDENCE_REQUIRED");
    expect(e.message).toMatch(/PRINTING is not required only on somebody's word/);
    const t = statement(w);
    delete t.processes[0].evidenceRef; // EMBROIDERY REQUIRED, on nobody's word
    await refused(w, t, "PROCESS_REQUIREMENT_EVIDENCE_REQUIRED");
  });

  test("evidence that is not a buyer approval on THIS order is refused", async () => {
    const w = await world("LprForeignEv");
    const other = await world("LprForeignEvB");
    const s = statement(w);
    s.processes[0].evidenceRef = other.evidenceRef;
    await refused(w, s, "PROCESS_REQUIREMENT_EVIDENCE_REQUIRED");
    s.processes[0].evidenceRef = "BUYER_PO:not-an-approval";
    await refused(w, s, "PROCESS_REQUIREMENT_EVIDENCE_REQUIRED");
  });

  test("a definite answer needs the buyer's specification with its evidence", async () => {
    const w = await world("LprNoSpec");
    const s = statement(w);
    delete s.processes[2].buyerSpecification;
    const e = await refused(w, s);
    expect(e.details.field).toBe("processRequirements.processes[2].buyerSpecification");
  });

  test("a missing process is refused — silence is never 'not required'", async () => {
    const w = await world("LprMissing");
    const s = statement(w);
    s.processes = s.processes.filter((p) => p.process !== "WASHING");
    const e = await refused(w, s);
    expect(e.details.missing).toEqual(["WASHING"]);
  });

  test("a process stated twice is refused", async () => {
    const w = await world("LprDup");
    const s = statement(w);
    s.processes.push({ ...s.processes[0], requirement: "NOT_REQUIRED" });
    const e = await refused(w, s);
    expect(e.message).toMatch(/EMBROIDERY is stated twice/);
  });

  test("an unchecked default is not an answer: a blank requirement is refused", async () => {
    const w = await world("LprBlank");
    const s = statement(w);
    s.processes[0].requirement = "";
    await refused(w, s);
    s.processes[0].requirement = false;
    await refused(w, s);
  });

  test("UNKNOWN cannot cite evidence; unexpected and money fields are refused by name", async () => {
    const w = await world("LprFields");
    const s = statement(w, { emb: "UNKNOWN" });
    s.processes[0].evidenceRef = w.evidenceRef;
    await refused(w, s);
    await refused(w, { ...statement(w), note: "free text" }, "FIELD_NOT_ACCEPTED");
    const priced = statement(w);
    priced.processes[0].price = 12;
    await refused(w, priced, "FIELD_NOT_ACCEPTED");
    const typed = statement(w);
    typed.processes[0].evidence = { kind: "BUYER_PO", documentRef: "typed" };
    await refused(w, typed, "FIELD_NOT_ACCEPTED");
  });

  test("an order confirmed without the buyer's approval on file can only say UNKNOWN", async () => {
    const w = await world("LprNoApproval", { approved: false });
    expect((await inspect(w)).body.lines[0].buyerApprovals).toEqual([]);
    await refused(w, statement({ evidenceRef: "BUYER_PO:anything" }), "PROCESS_REQUIREMENT_EVIDENCE_REQUIRED");
    const res = await issue(w, w.lines.a, { processRequirements: statement(w, { emb: "UNKNOWN", prn: "UNKNOWN", wash: "UNKNOWN" }) });
    expect(res.status).toBe(201);
  });
});

/* ══ VERSIONS AND THE MERCHANDISING COPY ══════════════════════════════════ */

describe("versions are never rewritten, and Merchandising keeps the accepted copy", () => {
  test("a version issued without a statement states nothing (the legacy shape)", async () => {
    const w = await world("LprLegacy");
    const res = await issue(w, w.lines.a, {});
    expect(res.status).toBe(201);
    const v = await SalesHandoverVersion.findById(res.body.version._id).lean();
    expect(v.executionProjection.processRequirements).toBeUndefined();
  });

  test("a buyer change is a successor; v1 keeps its statement; Merchandising's copy follows what it accepts", async () => {
    const w = await world("LprSucc");
    const merch = await actor({ companies: [w.co], role: "employee", grants: { merchandiser: "approver" } });
    const v1 = (await issue(w, w.lines.a, { processRequirements: statement(w, { wash: "NOT_REQUIRED" }) })).body.version;

    const accepted = await call(`/merchandising/handovers/${v1._id}/accept`, { token: merch.token, company: w.co._id, method: "POST", body: {} });
    expect(accepted.status).toBe(201);
    const shown = await call(`/merchandising/handovers/${v1._id}`, { token: merch.token, company: w.co._id });
    expect(shown.body.handover.processRequirements.processes.map((p) => [p.process, p.requirement, p.evidence.label])).toEqual([
      ["EMBROIDERY", "REQUIRED", "Buyer-approved order (PO)"], ["PRINTING", "NOT_REQUIRED", "Buyer-approved order (PO)"],
      ["WASHING", "NOT_REQUIRED", "Buyer-approved order (PO)"],
    ]);
    let file = await ExecutionFile.findOne({ handoverLineRef: w.lines.a }).lean();
    expect(file.currentExecutionProjection.processRequirements)
      .toEqual((await SalesHandoverVersion.findById(v1._id).lean()).executionProjection.processRequirements);

    /* The buyer adds a wash. Sales issues v2; nothing about v1 moves. */
    const before = JSON.stringify((await SalesHandoverVersion.findById(v1._id).lean()).executionProjection);
    const v2res = await issue(w, w.lines.a, { expectedCurrentVersionNo: 1, processRequirements: statement(w, { wash: "REQUIRED" }) });
    expect(v2res.status).toBe(201);
    const oldNow = await SalesHandoverVersion.findById(v1._id).lean();
    expect(JSON.stringify(oldNow.executionProjection)).toBe(before);
    expect(oldNow.publication.state).toBe("SUPERSEDED");
    expect(String(oldNow.publication.supersededByVersionId)).toBe(String(v2res.body.version._id));

    /* Merchandising still holds v1's statement until it accepts v2. */
    file = await ExecutionFile.findOne({ handoverLineRef: w.lines.a }).lean();
    expect(file.currentExecutionProjection.processRequirements.processes[2].requirement).toBe("NOT_REQUIRED");
    expect((await call(`/merchandising/handovers/${v2res.body.version._id}/accept`, { token: merch.token, company: w.co._id, method: "POST", body: {} })).status).toBe(201);
    file = await ExecutionFile.findOne({ handoverLineRef: w.lines.a }).lean();
    expect(file.currentExecutionProjection.processRequirements.processes[2].requirement).toBe("REQUIRED");
  });

  test("another company's seller finds no such order, and states nothing on it", async () => {
    const w = await world("LprIso");
    const other = await Acc_Company.create({ companyName: `LprIsoB ${++seq}`, booksFromDate: new Date("2026-04-01") });
    const stranger = await actor({ companies: [other] });
    expect((await inspect(w, stranger)).status).toBe(404);
    const res = await issue(w, w.lines.a, { processRequirements: statement(w) }, stranger);
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain("NW-PO-4471");
    expect(await SalesHandoverVersion.countDocuments({})).toBe(0);
  });
});

/* ══ THE EVIDENCE MUST BE THIS ROUND'S, AND THIS LINE'S ═══════════════════ */

describe("only a PO the buyer gave for the approved round, covering this line, is evidence", () => {
  const offered = async (w, i = 0) => (await inspect(w)).body.lines[i].buyerApprovals;
  const refusedWith = async (w, evidenceRef) => {
    const s = statement(w);
    s.processes[0].evidenceRef = evidenceRef;
    const res = await issue(w, w.lines.a, { processRequirements: s });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("PROCESS_REQUIREMENT_EVIDENCE_REQUIRED");
  };

  test("Sales pushing the order through without the customer (the real override shape) offers nothing", async () => {
    const w = await world("LprOverride", { quotations: [{
      quotationNumber: "Q-O", status: "sales_approved", revision: 1, date: new Date("2026-08-25"),
      customerApproval: { approved: true, approvedAt: new Date("2026-08-29"), approvedBy: null,
        notes: "Approved by sales (S) without customer approval or advance payment." },
    }] });
    expect(await offered(w)).toEqual([]);
    await refusedWith(w, w.evidenceRef);
    expect((await issue(w, w.lines.a, { processRequirements: statement(w, { emb: "UNKNOWN", prn: "UNKNOWN", wash: "UNKNOWN" }) })).status).toBe(201);
  });

  test("an internal order (the mark-internal-order shape) offers nothing", async () => {
    const w = await world("LprInternal", { isInternalOrder: true, quotations: [{
      items: [], status: "sales_approved", revision: 1, customerApproval: { approved: true, approvedAt: new Date("2026-08-29") },
    }] });
    expect(await offered(w)).toEqual([]);
    await refusedWith(w, w.evidenceRef);
  });

  test("a revised round still carrying the previous round's PO is not evidence for the revision", async () => {
    const w = await world("LprInherited", {
      quotationRevisions: [{ quotationNumber: "Q-R1", status: "customer_approved", revision: 1, date: new Date("2026-08-20"),
        customerApproval: { approved: true }, poProof: PO }],
      quotations: [{ quotationNumber: "Q-R2", status: "sales_approved", revision: 2, date: new Date("2026-09-01"),
        customerApproval: { approved: true, approvedAt: new Date("2026-09-02") }, poProof: PO }],
    });
    expect(await offered(w)).toEqual([]);
    await refusedWith(w, w.evidenceRef);
  });

  test("a PO uploaded before the approved round was issued is not that round's", async () => {
    const w = await world("LprEarly", { quotations: [{ quotationNumber: "Q-E", status: "sales_approved", revision: 2,
      date: new Date("2026-09-01"), customerApproval: { approved: true }, poProof: { ...PO, uploadedAt: new Date("2026-08-28") },
      items: [{ productLineRef: "PL-X-A", quantity: 500 }] }] });
    expect(await offered(w)).toEqual([]);
  });

  test("a reference read before a revise does not resolve to the round after it", async () => {
    const w = await world("LprStaleRef", { quotations: [{ quotationNumber: "Q-S", status: "sales_approved", revision: 3,
      date: new Date("2026-08-25"), customerApproval: { approved: true }, poProof: { ...PO, publicId: "grav/po/r3" },
      items: [{ productLineRef: "PL-S-A", quantity: 500 }] }] });
    /* The round names this line by its own product-line reference. */
    await CustomerRequest.updateOne({ _id: w.request._id }, { $set: { "items.0.productLineRef": "PL-S-A" } });
    const current = (await offered(w))[0].evidenceRef;
    expect(current).toMatch(/:r3$/);
    await refusedWith(w, current.replace(/:r3$/, ":r2"));
    await refusedWith(w, current.replace(/:r3$/, ""));
  });

  test("two lines of one style: the round covers only the line it names", async () => {
    const w = await world("LprCover");
    /* The round names line A's commercial product line, and only that. */
    await CustomerRequest.updateOne({ _id: w.request._id }, { $set: { "quotations.0.items": [
      { sampleStyleId: w.style._id, productLineRef: w.plr(0), stockItemName: "Polo", quantity: 500 },
    ] } });
    expect((await offered(w, 0)).map((a) => a.evidenceRef)).toEqual([w.evidenceRef]);
    expect(await offered(w, 1)).toEqual([]);
    /* So line B — same style, same PO, different commitment — stays unstated. */
    const s = statement(w);
    const res = await call(`/sales/merchandising-handovers/requests/${w.request._id}/lines/${w.lines.b}/issue`, {
      token: w.seller.token, method: "POST",
      body: { expectedCurrentVersionNo: 0, deliveries: [{ committedDeliveryDate: "2026-12-15", quantity: 300 }], processRequirements: s },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("PROCESS_REQUIREMENT_EVIDENCE_REQUIRED");
  });

  test("a shared style is never proof, and a round that identifies no line proves nothing for any", async () => {
    const w = await world("LprStyleOnly");
    /* Same style on the round, no line reference: two lines of one style are
       exactly what a style cannot tell apart. */
    await CustomerRequest.updateOne({ _id: w.request._id }, { $set: { "quotations.0.items": [
      { sampleStyleId: w.style._id, stockItemName: "Polo", quantity: 800 },
    ] } });
    expect(await offered(w, 0)).toEqual([]);
    expect(await offered(w, 1)).toEqual([]);
    await refusedWith(w, w.evidenceRef);

    /* A manually typed round names no lines at all: not proof for every line. */
    await CustomerRequest.updateOne({ _id: w.request._id }, { $set: { "quotations.0.items": [] } });
    expect(await offered(w, 0)).toEqual([]);
    expect(await offered(w, 1)).toEqual([]);
  });

  test("a product-line reference that is not one-to-one names neither line", async () => {
    const w = await world("LprAmbiguous");
    /* The same reference on two round items — it identifies no single line. */
    await CustomerRequest.updateOne({ _id: w.request._id }, { $set: { "quotations.0.items": [
      { productLineRef: w.plr(0), quantity: 200 }, { productLineRef: w.plr(0), quantity: 300 },
    ] } });
    expect(await offered(w, 0)).toEqual([]);
    /* And the same reference on two ORDER lines is no better. */
    await CustomerRequest.updateOne({ _id: w.request._id }, { $set: {
      "quotations.0.items": [{ productLineRef: w.plr(0), quantity: 500 }],
      "items.1.productLineRef": w.plr(0),
    } });
    expect(await offered(w, 0)).toEqual([]);
    expect(await offered(w, 1)).toEqual([]);
  });
});

describe("a genuine company order is authorised by Sales, and a pushed customer order is not", () => {
  /* The real mark-internal-order shape: the order IS an internal order, and a
     named Sales approver signed the round off. There is no buyer to approve. */
  const internalWorld = (label) => world(label, { isInternalOrder: true, quotations: [{
    quotationNumber: `Q-INT-${label}`, status: "sales_approved", revision: 1, date: new Date("2026-08-25"),
    items: [{ productLineRef: "PL-INT-A", quantity: 500 }],
    notes: "Internal / Company Order — no PI or payment required.",
    salesApproval: { approved: true, approvedAt: new Date("2026-08-26"), approvedBy: new mongoose.Types.ObjectId() },
  }] });
  const nameLineA = (w) => CustomerRequest.updateOne({ _id: w.request._id }, { $set: { "items.0.productLineRef": "PL-INT-A" } });
  const offered = async (w, i = 0) => (await inspect(w)).body.lines[i].buyerApprovals;

  test("a company order: Sales' own authorisation is offered, and freezes the approver and the reason", async () => {
    const w = await internalWorld("LprInt");
    await nameLineA(w);
    await CustomerRequest.updateOne({ _id: w.request._id }, { $set: { internalOrderMarkedAt: new Date("2026-08-24") } });
    const [option] = await offered(w);
    expect(option).toMatchObject({ kind: "INTERNAL_ORDER", label: "Company order — Sales-authorised, no buyer PO", needsReason: true });
    expect(option.evidenceRef).toMatch(/^INTERNAL_ORDER:/);

    const s = statement(w);
    for (const row of s.processes) { row.evidenceRef = option.evidenceRef; row.authorisationReason = "Company uniform order; processes decided by the factory."; }
    const res = await issue(w, w.lines.a, { processRequirements: s });
    expect(res.status).toBe(201);
    const stored = (await SalesHandoverVersion.findById(res.body.version._id).lean()).executionProjection.processRequirements;
    expect(stored.processes[0].evidence).toMatchObject({
      kind: "INTERNAL_ORDER", reason: "Company uniform order; processes decided by the factory.",
    });
    expect(String(stored.processes[0].evidence.authorisedById)).toBe(String(w.request.quotations[0].salesApproval.approvedBy));
    expect(stored.processes[0].evidence.documentRef).toBe("");
  });

  test("a company order still needs a reason, and a buyer-approved answer may not carry one", async () => {
    const w = await internalWorld("LprIntReason");
    await nameLineA(w);
    await CustomerRequest.updateOne({ _id: w.request._id }, { $set: { internalOrderMarkedAt: new Date("2026-08-24") } });
    const [option] = await offered(w);
    const s = statement(w);
    for (const row of s.processes) row.evidenceRef = option.evidenceRef;
    const noReason = await issue(w, w.lines.a, { processRequirements: s });
    expect(noReason.status).toBe(400);
    expect(noReason.body.error.code).toBe("PROCESS_REQUIREMENT_EVIDENCE_REQUIRED");
    expect(noReason.body.error.details.field).toMatch(/authorisationReason/);
    expect(await SalesHandoverVersion.countDocuments({ handoverLineRef: w.lines.a })).toBe(0);

    /* The other way round: a buyer's document is the authority, not a reason. */
    const buyer = await world("LprIntBuyerReason");
    const b = statement(buyer);
    b.processes[0].authorisationReason = "Because I say so, on a customer's order.";
    const refused = await issue(buyer, buyer.lines.a, { processRequirements: b });
    expect(refused.status).toBe(400);
  });

  test("an order that is NOT marked internal offers no Sales authorisation, however it was approved", async () => {
    /* A real customer's order Sales pushed through without the customer —
       a buyer exists and has not answered, so the line stays UNKNOWN. */
    const pushed = await world("LprPushed", { quotations: [{
      quotationNumber: "Q-P", status: "sales_approved", revision: 1, date: new Date("2026-08-25"),
      items: [{ productLineRef: "PL-P-A", quantity: 500 }],
      customerApproval: { approved: true, approvedAt: new Date("2026-08-29"), approvedBy: null,
        notes: "Approved by sales (S) without customer approval or advance payment." },
      salesApproval: { approved: true, approvedAt: new Date("2026-08-29"), approvedBy: new mongoose.Types.ObjectId() },
    }] });
    await CustomerRequest.updateOne({ _id: pushed.request._id }, { $set: { "items.0.productLineRef": "PL-P-A" } });
    expect(await offered(pushed)).toEqual([]);
    expect((await issue(pushed, pushed.lines.a, { processRequirements: statement(pushed, { emb: "UNKNOWN", prn: "UNKNOWN", wash: "UNKNOWN" }) })).status).toBe(201);
  });
});

describe("a stated requirement is never lost or rewritten in place", () => {
  test("a successor that omits a stated requirement is refused; restating it succeeds", async () => {
    const w = await world("LprRestate");
    expect((await issue(w, w.lines.a, { processRequirements: statement(w) })).status).toBe(201);
    const omitted = await issue(w, w.lines.a, { expectedCurrentVersionNo: 1 });
    expect(omitted.status).toBe(409);
    expect(omitted.body.error.code).toBe("PROCESS_REQUIREMENT_RESTATE_REQUIRED");
    expect(await SalesHandoverVersion.countDocuments({ handoverLineRef: w.lines.a })).toBe(1);
    expect((await issue(w, w.lines.a, { expectedCurrentVersionNo: 1, processRequirements: statement(w) })).status).toBe(201);
  });

  test("an issued version refuses an in-place edit of its statement; its publication may still move", async () => {
    const w = await world("LprFrozen");
    const v = (await issue(w, w.lines.a, { processRequirements: statement(w) })).body.version;
    const doc = await SalesHandoverVersion.findById(v._id);
    doc.executionProjection.processRequirements.processes[0].requirement = "NOT_REQUIRED";
    await expect(doc.save()).rejects.toThrow(/buyer-approved processes cannot change/);
    const again = await SalesHandoverVersion.findById(v._id);
    again.publication.state = "SUPERSEDED";
    await expect(again.save()).resolves.toBeTruthy();
    expect((await SalesHandoverVersion.findById(v._id).lean()).executionProjection.processRequirements.processes[0].requirement).toBe("REQUIRED");
  });
});

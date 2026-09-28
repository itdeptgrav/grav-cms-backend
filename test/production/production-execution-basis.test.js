// test/production/production-execution-basis.test.js
//
// PRODUCTION EXECUTION BASIS — Production's own, frozen receipt of a PPC SEWING
// publication for an EXISTING WorkOrder, embedded as
// `WorkOrder.productionExecutionBases[]`, and Flow Tracking reading ONLY it.
//
// Against an in-memory replica set (test/setup.js). PPC and IE fixtures are
// inserted through the raw collections, so a test can later "edit" or delete
// them exactly as a careless writer could, and prove the stored basis does
// not move.
"use strict";
process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const Employee = require("../../models/Employee");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const WorkOrder = require("../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const ProductionEvent = require("../../models/CMS_Models/Manufacturing/Production/Barcode/ProductionEvent");
const { PpcStagePublication } = require("../../models/CMS_Models/PPC/PpcStagePublication");
const { PpcCapacityBooking } = require("../../models/CMS_Models/PPC/PpcCapacityBooking");
const { PpcCapacityLine } = require("../../models/CMS_Models/PPC/PpcCapacityLine");
const IeRelease = require("../../models/CMS_Models/IndustrialEngineering/IeRelease");
const basisSchemaModule = require("../../models/CMS_Models/Manufacturing/WorkOrder/productionExecutionBasis.schema");
const { EXECUTION_BASIS_WRITE_OPTION, RECEIPT_FENCE_FIELD } = basisSchemaModule;
const { createExecutionBasisService, MAX_ATTEMPTS, COMMIT_ATTEMPTS } = require("../../services/production/executionBasis/executionBasis.service");
const { receiptKeyOf } = require("../../services/production/executionBasis/executionBasis.rules");
const { createFlowTrackingService } = require("../../services/production/flowTracking/flowTracking.service");

const { ObjectId } = mongoose.Types;
let http, base, seq = 0;
const ROOT = "/api/cms/production";

beforeAll(async () => {
  // Settle the collections first: a transaction cannot lock a collection that
  // is still being created or indexed (see support/executionBasisFixtures.js).
  await require("./support/executionBasisFixtures").settleCollections();
  const app = express();
  app.use(express.json());
  /* As server.js mounts them. */
  app.use(`${ROOT}/supervisor`, require("../../routes/CMS_Routes/Production/Scanner/flowTrackingRoutes"));
  app.use(`${ROOT}/execution-bases`, require("../../routes/CMS_Routes/Production/ExecutionBasis/executionBasisRoutes"));
  await new Promise((r) => { http = app.listen(0, r); });
  base = `http://127.0.0.1:${http.address().port}${ROOT}`;
});
afterAll(async () => { await new Promise((r) => http.close(r)); });

const call = (path, { token, method = "GET", body } = {}) => fetch(`${base}${path}`, {
  method,
  headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
}).then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

async function person({ companies = [], dept = "production-supervisor", role = "production_supervisor", grants = {} } = {}) {
  const n = ++seq;
  const email = `peb${n}@grav.test`;
  const emp = await Employee.create({ firstName: "Prod", lastName: `N${n}`, email, biometricId: `PEB${n}`,
    isActive: true, gender: "Other", department: "Production", designation: "Supervisor" });
  for (const co of companies) await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: emp._id, personName: "P" });
  for (const [departmentSlug, r] of Object.entries(grants)) {
    await DepartmentRole.create({ departmentSlug, email, name: "P", role: r, isActive: true, departmentId: new ObjectId() });
  }
  return { emp, token: jwt.sign({ id: String(emp._id), email, name: `Prod N${n}`, role, deptSlug: dept, employeeId: emp.biometricId },
    process.env.JWT_SECRET, { expiresIn: "10m" }) };
}

const company = async (label) => Acc_Company.create({ companyName: `${label} ${++seq}`, booksFromDate: new Date("2026-04-01") });
const lineRefOf = () => `LN-${(++seq).toString(16).padStart(12, "0")}`;

/* ── Coherent PPC / IE / WorkOrder fixtures ─────────────────────────────── */

async function workOrderFor(co, { quantity = 10, linked = true, orderLineRef = lineRefOf(), status = "in_progress" } = {}) {
  const customerRequestId = new ObjectId();
  const wo = await WorkOrder.create({
    customerRequestId, quantity, status,
    operations: [{ operationType: "Editable A", operationCode: "P001" }, { operationType: "Editable B", operationCode: "P002" }],
    ...(linked ? { salesLineLink: { companyId: co._id, customerRequestId, lineRef: orderLineRef, basis: "sales_line", linkedAt: new Date() } } : {}),
  });
  return { wo, orderLineRef };
}

async function lineFor(co, over = {}) {
  const doc = { _id: new ObjectId(), companyId: co._id, lineRef: `LINE-${++seq}`, name: `Sewing line ${seq}`, factoryRef: "UNIT-1",
    externalRef: "", calendarId: new ObjectId(), operatorCount: 20, status: "ACTIVE", revision: 3, bookingFence: 0, ...over };
  await PpcCapacityLine.collection.insertOne(doc);
  return doc;
}

async function releaseFor(co, codes = ["SJ-01", "BA-03", "HM-02"], over = {}) {
  const doc = {
    _id: new ObjectId(), companyId: co._id, releaseRef: `IER-${++seq}`, versionNo: 2, state: "ISSUED",
    aggregateFingerprint: `agg-${seq}`, ieStyleFileId: new ObjectId(), sampleStyleId: new ObjectId(),
    source: {
      bulletinVersionId: new ObjectId(), bulletinVersionNo: 4, sourceFingerprint: `src-${seq}`,
      rows: codes.map((code, i) => ({ rowId: `row-${seq}-${i + 1}`, sequence: i + 1, ieOperationId: new ObjectId(), ieOperationRevision: 1,
        operationCode: code, operationName: `Op ${code}`, machineType: "SNLS", standardTimeMinutes: 0.5 + i, standardTimeSource: "method_study" })),
      garmentSamMinutes: 4, samRowCount: codes.length, lineLayout: {}, capacityStandard: {}, capturedAt: new Date(),
    },
    issuedBy: new ObjectId(), issuedAt: new Date(), ...over,
  };
  await IeRelease.collection.insertOne(doc);
  return doc;
}

async function bookingFor(co, { line, release, planningFileId, orderLineRef, over = {} }) {
  const doc = {
    _id: new ObjectId(), companyId: co._id, bookingRef: `BK-${++seq}`, planningFileId, planningFileRef: `PF-${seq}`, planningFileRevision: 1,
    orderLineRef, lineId: line._id, lineRef: line.lineRef, lineRevision: line.revision, lineOperatorCount: 20,
    calendarId: new ObjectId(), calendarRef: "CAL-1", calendarVersionNo: 1,
    basis: { ieReleaseId: release._id, ieReleaseRef: release.releaseRef, ieReleaseVersionNo: release.versionNo, confirmedQuantity: 10 },
    windowStart: "2026-10-01", windowEnd: "2026-10-05", allocations: [], bookedOperatorMinutes: 100,
    state: "ACTIVE", generation: 1, revision: 1, history: [], ...over,
  };
  await PpcCapacityBooking.collection.insertOne(doc);
  return doc;
}

async function publicationFor(co, { wo, orderLineRef, release, booking, line, planningFileId, over = {}, publishedQuantity = 10 }) {
  const doc = {
    _id: new ObjectId(), companyId: co._id, orderLineRef, planningFileId, planningFileRef: `PF-${++seq}`, planningGeneration: 1,
    scheduleVersionNo: 1, ieReleaseId: release._id, ieReleaseRef: release.releaseRef, ieReleaseVersionNo: release.versionNo,
    stageId: "stage-sew", process: "SEWING", stageLabel: "Sewing", confirmedQuantity: 10,
    plannedStart: "2026-10-01", plannedEnd: "2026-10-05",
    workOrders: [{ workOrderId: wo._id, workOrderNumber: wo.workOrderNumber, lineRef: orderLineRef, basis: "sales_line", quantity: publishedQuantity }],
    capacityBooking: { bookingId: booking._id, bookingRef: booking.bookingRef, generation: booking.generation, lineId: line._id,
      lineRef: line.lineRef, calendarVersionNo: 1, windowStart: "2026-10-01", windowEnd: "2026-10-05" },
    publicationVersionNo: 1, supersedesVersionId: null, supersededByVersionId: null, changes: [],
    state: "ACCEPTED", isCurrent: true, response: { state: "ACCEPTED", at: new Date(), by: { id: new ObjectId(), name: "Sewing" }, reason: "" },
    publishedAt: new Date(Date.now() - 3600e3), ...over,
  };
  await PpcStagePublication.collection.insertOne(doc);
  return doc;
}

/** One company with one fully eligible WorkOrder + publication. `mutate` edits sources before insert. */
async function world(label, { co, line: sharedLine, mutate = {} } = {}) {
  const mine = co || await company(`${label}Mine`);
  const { wo, orderLineRef } = await workOrderFor(mine, mutate.workOrder || {});
  const line = sharedLine || await lineFor(mine, mutate.line || {});
  const release = await releaseFor(mine, mutate.codes, mutate.release || {});
  const planningFileId = new ObjectId();
  const booking = await bookingFor(mine, { line, release, planningFileId, orderLineRef, over: mutate.booking || {} });
  const publication = await publicationFor(mine, { wo, orderLineRef, release, booking, line, planningFileId,
    over: mutate.publication || {}, publishedQuantity: "publishedQuantity" in mutate ? mutate.publishedQuantity : 10 });
  return { co: mine, wo, orderLineRef, line, release, booking, publication, planningFileId };
}

const svc = (now) => createExecutionBasisService(now ? { now: () => now } : {});
const receive = (w, extra = {}) => svc(extra.now).receive({ companyId: String(w.co._id), workOrderId: String(w.wo._id),
  publicationId: String(w.publication._id), actor: { id: String(new ObjectId()), name: "Supervisor" }, ...extra });
const basesOf = async (id) => (await WorkOrder.findById(id).select("+productionExecutionBases").lean()).productionExecutionBases || [];
const rejectsWith = async (promise, code) => {
  await expect(promise).rejects.toMatchObject({ code });
};

/* ══ 1–3, 20: RECEIPT, IDEMPOTENCY, CONCURRENCY ═══════════════════════════ */

describe("receiving an accepted current SEWING publication", () => {
  test("creates one frozen, self-contained basis derived only from server records", async () => {
    const w = await world("Ok");
    const { basis, reused } = await receive(w);
    expect(reused).toBe(false);
    const [stored] = await basesOf(w.wo._id);
    expect(stored.receiptKey).toBe(receiptKeyOf(w.co._id, w.wo._id, w.publication._id));
    expect(stored).toMatchObject({
      versionNo: 1, state: "ACTIVE", orderLineRef: w.orderLineRef, executionQuantity: 10,
      basisRef: `PEB-${String(w.wo._id).slice(-8)}-V1`,
      publication: { publicationVersionNo: 1, process: "SEWING", stageId: "stage-sew", confirmedQuantity: 10, publishedWorkOrderQuantity: 10 },
      planning: { planningGeneration: 1, scheduleVersionNo: 1 },
      capacityBooking: { bookingRef: w.booking.bookingRef, generation: 1, windowStart: "2026-10-01", windowEnd: "2026-10-05" },
      planningLine: { lineRef: w.line.lineRef, lineRevision: 3, factoryRefDisplay: "UNIT-1", factoryRefAuthoritative: false },
      ieRelease: { releaseRef: w.release.releaseRef, versionNo: 2, aggregateFingerprint: w.release.aggregateFingerprint,
        sourceFingerprint: w.release.source.sourceFingerprint, bulletinVersionNo: 4 },
      plannedWindow: { start: "2026-10-01", end: "2026-10-05" },
      receivedBy: { name: "Supervisor" },
    });
    expect(String(stored.planningLine.capacityLineId)).toBe(String(w.line._id));
    expect(stored.route.map((r) => [r.rowId, r.sequence, r.operationCode, r.standardTimeMinutes, r.ieOperationRevision]))
      .toEqual(w.release.source.rows.map((r) => [r.rowId, r.sequence, r.operationCode, r.standardTimeMinutes, 1]));
    expect(stored.history.map((h) => h.type)).toEqual(["RECEIVED"]);
    expect(String(basis.basisId)).toBe(String(stored.basisId));
  });

  test("an identical replay returns the same basis and appends nothing", async () => {
    const w = await world("Replay");
    const first = await receive(w);
    const second = await receive(w);
    expect(second.reused).toBe(true);
    expect(String(second.basis.basisId)).toBe(String(first.basis.basisId));
    expect(await basesOf(w.wo._id)).toHaveLength(1);
  });

  test("the conditional update itself refuses a duplicate receipt key (database-level gate)", async () => {
    const w = await world("Gate");
    const { basis } = await receive(w);
    const dup = { ...basis, basisId: new ObjectId(), versionNo: 2, state: "SUPERSEDED" };
    const r = await WorkOrder.updateOne(
      { _id: w.wo._id, "productionExecutionBases.receiptKey": { $ne: basis.receiptKey } },
      { $push: { productionExecutionBases: dup } },
      { [EXECUTION_BASIS_WRITE_OPTION]: true },
    );
    expect(r.modifiedCount).toBe(0);
    expect(await basesOf(w.wo._id)).toHaveLength(1);
  });

  test("ten concurrent receipts of the same publication append exactly one basis", async () => {
    const w = await world("Race");
    const results = await Promise.all(Array.from({ length: 10 }, () => receive(w)));
    const ids = new Set(results.map((r) => String(r.basis.basisId)));
    expect(ids.size).toBe(1);
    expect(results.filter((r) => !r.reused)).toHaveLength(1);
    expect(await basesOf(w.wo._id)).toHaveLength(1);
  });

  test("concurrent receipts of two different eligible publications: one wins, the other conflicts", async () => {
    const w = await world("RaceTwo");
    // A second, independent eligible plan for the same WorkOrder.
    const pf2 = new ObjectId();
    const booking2 = await bookingFor(w.co, { line: w.line, release: w.release, planningFileId: pf2, orderLineRef: w.orderLineRef });
    const pub2 = await publicationFor(w.co, { wo: w.wo, orderLineRef: w.orderLineRef, release: w.release, booking: booking2, line: w.line, planningFileId: pf2 });
    const outcomes = await Promise.allSettled([receive(w), receive(w, { publicationId: String(pub2._id) })]);
    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.find((o) => o.status === "rejected").reason.code).toBe("EXECUTION_BASIS_CONFLICT");
    expect(await basesOf(w.wo._id)).toHaveLength(1);
  });
});

/* ══ 4–17: ELIGIBILITY, EVERY PROOF ═══════════════════════════════════════ */

describe("eligibility is proved from server records, never assumed", () => {
  test("foreign-company publication and WorkOrder, and unlinked WorkOrders", async () => {
    const a = await world("ForeignA");
    const b = await world("ForeignB");
    await rejectsWith(receive(a, { publicationId: String(b.publication._id) }), "PUBLICATION_NOT_FOUND");
    await rejectsWith(receive(a, { workOrderId: String(b.wo._id) }), "WORK_ORDER_NOT_FOUND");
    const { wo: unlinked } = await workOrderFor(a.co, { linked: false });
    await rejectsWith(receive(a, { workOrderId: String(unlinked._id) }), "WORK_ORDER_NOT_FOUND");
    expect(await basesOf(b.wo._id)).toHaveLength(0);
  });

  test("a publication that does not name the WorkOrder", async () => {
    const w = await world("NotNamed");
    const { wo: other } = await workOrderFor(w.co, { orderLineRef: w.orderLineRef });
    await rejectsWith(receive(w, { workOrderId: String(other._id) }), "PUBLICATION_WORK_ORDER_MISMATCH");
  });

  test("a Sales-line mismatch", async () => {
    const w = await world("LineMismatch", { mutate: { publication: { orderLineRef: "LN-ffffffffffff" } } });
    await rejectsWith(receive(w), "SALES_LINE_MISMATCH");
  });

  test.each([
    ["AWAITING", { state: "AWAITING", response: {} }, "PUBLICATION_NOT_ACCEPTED"],
    ["REFUSED", { state: "REFUSED", response: { state: "REFUSED", reason: "No capacity" } }, "PUBLICATION_REFUSED"],
    ["SUPERSEDED", { state: "SUPERSEDED", isCurrent: false }, "PUBLICATION_NOT_CURRENT"],
    ["non-current", { isCurrent: false }, "PUBLICATION_NOT_CURRENT"],
    ["non-SEWING", { process: "CUTTING" }, "PUBLICATION_NOT_SEWING"],
  ])("a %s publication is not executable", async (_label, over, code) => {
    const w = await world(`Pub${_label}`, { mutate: { publication: over } });
    await rejectsWith(receive(w), code);
    expect(await basesOf(w.wo._id)).toHaveLength(0);
  });

  test("a missing or mismatched IE release, and an unusable frozen route", async () => {
    const missing = await world("IeMissing", { mutate: { publication: { ieReleaseId: new ObjectId() } } });
    await rejectsWith(receive(missing), "IE_RELEASE_NOT_FOUND");
    const mismatched = await world("IeMismatch", { mutate: { publication: { ieReleaseVersionNo: 1 } } });
    await rejectsWith(receive(mismatched), "IE_RELEASE_MISMATCH");
    const incomplete = await world("IeIncomplete", { mutate: { publication: { ieReleaseVersionNo: null } } });
    await rejectsWith(receive(incomplete), "IE_RELEASE_REFERENCE_INCOMPLETE");
    const empty = await world("IeEmpty", { mutate: { codes: [] } });
    await rejectsWith(receive(empty), "FROZEN_ROUTE_UNUSABLE");
    const dupCodes = await world("IeDup", { mutate: { codes: ["SJ-01", "SJ-01"] } });
    await expect(receive(dupCodes)).rejects.toMatchObject({ code: "FROZEN_ROUTE_UNUSABLE", details: { problems: ["operation_code_duplicated:sj-01"] } });
  });

  test("a missing, inactive, stale or other-line capacity booking", async () => {
    await rejectsWith(receive(await world("BkMissing", { mutate: { publication: { capacityBooking: null } } })), "CAPACITY_BOOKING_MISSING");
    await rejectsWith(receive(await world("BkReleased", { mutate: { booking: { state: "RELEASED" } } })), "CAPACITY_BOOKING_INACTIVE");
    const stale = await world("BkStale");
    // PPC re-booked (generation 2) after the publication froze generation 1.
    await PpcCapacityBooking.collection.updateOne({ _id: stale.booking._id }, { $set: { generation: 2 } });
    await rejectsWith(receive(stale), "CAPACITY_BOOKING_STALE");
    const otherLine = await world("BkOtherLine");
    await PpcStagePublication.collection.updateOne({ _id: otherLine.publication._id }, { $set: { "capacityBooking.lineId": new ObjectId() } });
    await rejectsWith(receive(otherLine), "CAPACITY_BOOKING_LINE_MISMATCH");
    await rejectsWith(receive(await world("BkWrongPlan", { mutate: { booking: { orderLineRef: "LN-eeeeeeeeeeee" } } })), "CAPACITY_BOOKING_MISMATCH");
  });

  test("an unprovable planning line: foreign company, retired, or revised after booking", async () => {
    const foreignCo = await company("LineOwner");
    const foreignLine = await lineFor(foreignCo);
    const w = await world("LineForeign");
    await PpcCapacityBooking.collection.updateOne({ _id: w.booking._id }, { $set: { lineId: foreignLine._id, lineRef: foreignLine.lineRef } });
    await PpcStagePublication.collection.updateOne({ _id: w.publication._id },
      { $set: { "capacityBooking.lineId": foreignLine._id, "capacityBooking.lineRef": foreignLine.lineRef } });
    await rejectsWith(receive(w), "CAPACITY_LINE_NOT_FOUND");
    await rejectsWith(receive(await world("LineRetired", { mutate: { line: { status: "RETIRED" } } })), "CAPACITY_LINE_RETIRED");
    const revised = await world("LineRevised");
    await PpcCapacityLine.collection.updateOne({ _id: revised.line._id }, { $set: { revision: 4 } });
    await rejectsWith(receive(revised), "CAPACITY_LINE_REVISION_MISMATCH");
  });

  test("an incompatible or unprovable quantity", async () => {
    await rejectsWith(receive(await world("QtyDiff", { mutate: { workOrder: { quantity: 12 } } })), "QUANTITY_INCOMPATIBLE");
    await rejectsWith(receive(await world("QtyNone", { mutate: { publishedQuantity: null } })), "QUANTITY_UNPROVABLE");
  });

  test("a cancelled WorkOrder, and a conflicting active basis", async () => {
    await rejectsWith(receive(await world("Cancelled", { mutate: { workOrder: { status: "cancelled" } } })), "WORK_ORDER_CANCELLED");
    const w = await world("Conflict");
    await receive(w);
    const pf2 = new ObjectId();
    const booking2 = await bookingFor(w.co, { line: w.line, release: w.release, planningFileId: pf2, orderLineRef: w.orderLineRef });
    const pub2 = await publicationFor(w.co, { wo: w.wo, orderLineRef: w.orderLineRef, release: w.release, booking: booking2, line: w.line, planningFileId: pf2 });
    await expect(receive(w, { publicationId: String(pub2._id) })).rejects.toMatchObject({ code: "EXECUTION_BASIS_CONFLICT", status: 409 });
    expect(await basesOf(w.wo._id)).toHaveLength(1);
  });
});

/* ══ 18, 19, 21: SUCCESSION, HISTORY, FROZENNESS ══════════════════════════ */

/** PPC republishes the same stage: v1 superseded, v2 accepted, new release. */
async function republish(w, codes = ["NEW-1", "NEW-2"]) {
  const release2 = await releaseFor(w.co, codes);
  // PPC's own rule: one ACTIVE booking per plan, so the old one is superseded first.
  await PpcCapacityBooking.collection.updateOne({ _id: w.booking._id }, { $set: { state: "SUPERSEDED" } });
  const booking2 = await bookingFor(w.co, { line: w.line, release: release2, planningFileId: w.planningFileId, orderLineRef: w.orderLineRef,
    over: { generation: 2 } });
  await PpcStagePublication.collection.updateOne({ _id: w.publication._id }, { $set: { isCurrent: false, state: "SUPERSEDED" } });
  const pub2 = await publicationFor(w.co, { wo: w.wo, orderLineRef: w.orderLineRef, release: release2, booking: booking2, line: w.line,
    planningFileId: w.planningFileId, over: { publicationVersionNo: 2, supersedesVersionId: w.publication._id } });
  return { release2, booking2, pub2 };
}

describe("successor versions", () => {
  test("a successor atomically supersedes the active basis and preserves it", async () => {
    const w = await world("Succ");
    const t1 = new Date("2026-10-01T04:00:00Z");
    const t2 = new Date("2026-10-02T04:00:00Z");
    const { basis: v1 } = await receive(w, { now: t1 });
    const { pub2 } = await republish(w);
    // /receive refuses: an active basis needs the explicit successor command.
    await rejectsWith(receive(w, { publicationId: String(pub2._id), now: t2 }), "EXECUTION_BASIS_CONFLICT");
    await rejectsWith(svc(t2).supersede({ companyId: String(w.co._id), workOrderId: String(w.wo._id), publicationId: String(pub2._id),
      supersedesBasisId: String(v1.basisId), reason: "short" }), "SUPERSEDE_REASON_REQUIRED");

    const { basis: v2, reused } = await svc(t2).supersede({ companyId: String(w.co._id), workOrderId: String(w.wo._id),
      publicationId: String(pub2._id), supersedesBasisId: String(v1.basisId), reason: "PPC republished the sewing stage with release 2." });
    expect(reused).toBe(false);
    const [old, current] = await basesOf(w.wo._id);
    expect(old).toMatchObject({ versionNo: 1, state: "SUPERSEDED", supersedeReason: "PPC republished the sewing stage with release 2." });
    expect(old.effectiveUntil.toISOString()).toBe(t2.toISOString());
    expect(String(old.supersededByBasisId)).toBe(String(v2.basisId));
    expect(old.history.map((h) => h.type)).toEqual(["RECEIVED", "SUPERSEDED"]);
    expect(old.route.map((r) => r.operationCode)).toEqual(["SJ-01", "BA-03", "HM-02"]); // untouched
    expect(current).toMatchObject({ versionNo: 2, state: "ACTIVE" });
    expect(String(current.supersedesBasisId)).toBe(String(v1.basisId));
    expect(current.route.map((r) => r.operationCode)).toEqual(["NEW-1", "NEW-2"]);

    // Replay of the successor is idempotent; a second different successor attempt against v1 is invalid.
    expect((await svc(t2).supersede({ companyId: String(w.co._id), workOrderId: String(w.wo._id), publicationId: String(pub2._id),
      supersedesBasisId: String(v1.basisId), reason: "PPC republished the sewing stage with release 2." })).reused).toBe(true);
    expect(await basesOf(w.wo._id)).toHaveLength(2);
  });

  test("two concurrent successor commands produce exactly one successor", async () => {
    const w = await world("SuccRace");
    const { basis: v1 } = await receive(w);
    const { pub2 } = await republish(w);
    const args = { companyId: String(w.co._id), workOrderId: String(w.wo._id), publicationId: String(pub2._id),
      supersedesBasisId: String(v1.basisId), reason: "Republished by PPC after replanning." };
    const results = await Promise.all(Array.from({ length: 6 }, () => svc().supersede(args)));
    expect(new Set(results.map((r) => String(r.basis.basisId))).size).toBe(1);
    const bases = await basesOf(w.wo._id);
    expect(bases.map((b) => [b.versionNo, b.state])).toEqual([[1, "SUPERSEDED"], [2, "ACTIVE"]]);
  });

  test("a successor from a different plan is not a successor", async () => {
    const w = await world("SuccWrong");
    const { basis: v1 } = await receive(w);
    const pf2 = new ObjectId();
    const booking2 = await bookingFor(w.co, { line: w.line, release: w.release, planningFileId: pf2, orderLineRef: w.orderLineRef });
    const pub2 = await publicationFor(w.co, { wo: w.wo, orderLineRef: w.orderLineRef, release: w.release, booking: booking2, line: w.line,
      planningFileId: pf2, over: { publicationVersionNo: 2 } });
    await rejectsWith(svc().supersede({ companyId: String(w.co._id), workOrderId: String(w.wo._id), publicationId: String(pub2._id),
      supersedesBasisId: String(v1.basisId), reason: "Trying to swap plans silently." }), "EXECUTION_BASIS_SUCCESSOR_INVALID");
  });

  test("editing or deleting the WorkOrder route, IE release, PPC publication, booking or line changes no stored basis", async () => {
    const w = await world("Frozen");
    await receive(w);
    const before = await basesOf(w.wo._id);
    await WorkOrder.updateOne({ _id: w.wo._id }, { $set: { operations: [{ operationCode: "XX" }], quantity: 99 } });
    await IeRelease.collection.updateOne({ _id: w.release._id }, { $set: { "source.rows": [], releaseRef: "EDITED" } });
    await PpcStagePublication.collection.updateOne({ _id: w.publication._id }, { $set: { plannedEnd: "2027-01-01", confirmedQuantity: 1 } });
    await PpcCapacityBooking.collection.updateOne({ _id: w.booking._id }, { $set: { state: "RELEASED" } });
    await PpcCapacityLine.collection.updateOne({ _id: w.line._id }, { $set: { factoryRef: "ELSEWHERE", revision: 9, name: "Renamed" } });
    await IeRelease.collection.deleteOne({ _id: w.release._id });
    expect(await basesOf(w.wo._id)).toEqual(before);
  });
});

/* ══ MODEL SAFETY ═════════════════════════════════════════════════════════ */

describe("generic WorkOrder writes cannot carry an execution basis", () => {
  const fake = () => ({ basisId: new ObjectId(), basisRef: "PEB-x", versionNo: 1, receiptKey: "forged", state: "ACTIVE" });

  test("create, save, insertMany and every update/replace shape are refused", async () => {
    await expect(new WorkOrder({ quantity: 1, productionExecutionBases: [fake()] }).save()).rejects.toThrow(/execution-basis service/);
    await expect(WorkOrder.create({ quantity: 1, productionExecutionBases: [fake()] })).rejects.toThrow(/execution-basis service/);
    await expect(WorkOrder.insertMany([{ quantity: 1, productionExecutionBases: [fake()] }])).rejects.toThrow(/execution-basis service/);

    const w = await world("Guard");
    await receive(w);
    const id = w.wo._id;
    for (const update of [
      { $set: { productionExecutionBases: [] } },
      { $push: { productionExecutionBases: fake() } },
      { $unset: { productionExecutionBases: 1 } },
      { $set: { "productionExecutionBases.0.state": "SUPERSEDED" } },
      { $set: { "productionExecutionBases.$[].executionQuantity": 1 } },
      { productionExecutionBases: [] },
      [{ $set: { productionExecutionBases: [] } }],
      [{ $replaceWith: { _id: "$_id" } }],
    ]) {
      await expect(WorkOrder.updateOne({ _id: id }, update)).rejects.toThrow(/execution-basis service/);
      await expect(WorkOrder.findByIdAndUpdate(id, update)).rejects.toThrow(/execution-basis service/);
      await expect(WorkOrder.updateMany({ _id: id }, update)).rejects.toThrow(/execution-basis service/);
    }
    await expect(WorkOrder.replaceOne({ _id: id }, { quantity: 1 })).rejects.toThrow(/replacement is refused/);

    const loaded = await WorkOrder.findById(id).select("+productionExecutionBases");
    loaded.productionExecutionBases[0].executionQuantity = 1;
    await expect(loaded.save()).rejects.toThrow(/execution-basis service/);
    expect((await basesOf(id))[0].executionQuantity).toBe(10);
  });

  test("ordinary reads never carry the frozen routes; unrelated writes and legacy documents work", async () => {
    const w = await world("Compat");
    await receive(w);
    expect((await WorkOrder.findById(w.wo._id).lean()).productionExecutionBases).toBeUndefined();
    expect((await WorkOrder.findById(w.wo._id)).productionExecutionBases).toBeUndefined();
    await WorkOrder.updateOne({ _id: w.wo._id }, { $set: { status: "paused" } });
    const doc = await WorkOrder.findById(w.wo._id);
    doc.priority = "high";
    await doc.save();
    expect(await basesOf(w.wo._id)).toHaveLength(1);

    const legacy = await WorkOrder.create({ quantity: 3 });
    expect(Object.prototype.hasOwnProperty.call(await WorkOrder.collection.findOne({ _id: legacy._id }), "productionExecutionBases")).toBe(false);
    legacy.status = "paused";
    await legacy.save();
  });

  test("no new MongoDB collection is declared or created", async () => {
    expect(Object.values(basisSchemaModule).some((v) => v?.prototype instanceof mongoose.Model)).toBe(false);
    expect(mongoose.modelNames().filter((n) => /execution/i.test(n))).toEqual([]);
    const w = await world("Collections");
    const names = async () => (await mongoose.connection.db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name).sort();
    const before = await names();
    await receive(w);
    expect(await names()).toEqual(before);
  });
});

/* ══ 22–25: FLOW TRACKING READS ONLY THE EXECUTION BASIS ══════════════════ */

let evSeq = 0;
const scanEvent = (wo, unit, code, at) => ({
  eventId: `peb-dev-${++evSeq}`, type: "scan", machineId: new ObjectId(), barcodeId: `WO-${String(wo._id).slice(-8)}-${unit}`,
  workOrderKey: String(wo._id).slice(-8), unitNumber: unit, activeOps: [code], scanTime: at, shiftDate: at,
});

describe("flow tracking on the execution basis", () => {
  test("uses only the basis; fails closed without one; editable route and PPC records are never read", async () => {
    const w = await world("Flow");
    const flow = createFlowTrackingService();
    const now = new Date();
    await ProductionEvent.insertMany([
      ...[1, 2, 3, 4].map((u) => scanEvent(w.wo, u, "SJ-01", new Date(now - 60e3 * 30))),
      scanEvent(w.wo, 1, "BA-03", new Date(now - 60e3 * 10)),
      scanEvent(w.wo, 2, "P001", new Date(now - 60e3 * 10)), // the editable route's code: never attributed
    ]);
    const without = await flow.workOrderFlow({ companyId: String(w.co._id), workOrderId: String(w.wo._id) });
    expect(without).toMatchObject({ confidence: "unknown", reasons: ["production_execution_basis_unavailable"], edges: [] });

    await receive(w, { now: new Date(now - 3600e3) });
    const r = await flow.workOrderFlow({ companyId: String(w.co._id), workOrderId: String(w.wo._id) });
    expect(r.route.basis.source).toBe("production_execution_basis");
    expect(r.edges[0]).toMatchObject({ completedUpstream: 4, completedDownstream: 1, wipPieces: 3, confidence: "calculated" });
    expect(r.dataQuality.unattributedScans).toBe(1);
    expect(r.planningLineScope).toMatchObject({ capacityLineId: String(w.line._id), lineRef: w.line.lineRef, revision: 3, factoryRefAuthoritative: false });
    expect(r.siteScope).toEqual({ status: "not_modelled" });
    expect(r.physicalLineMapping).toEqual({ status: "unavailable" });
    // Machine context now comes from server-owned assignments; there are none here.
    expect(r.machineContext).toMatchObject({ source: "server_owned_machine_assignment", status: "resolved" });
    expect(r.edges.every((e) => e.currentContext.upstreamMachineIds.length === 0 && e.currentContext.downstreamMachineIds.length === 0)).toBe(true);

    // Deleting every PPC and IE source record changes nothing: the basis is self-contained.
    await PpcStagePublication.collection.deleteMany({});
    await IeRelease.collection.deleteMany({});
    await PpcCapacityBooking.collection.deleteMany({});
    const again = await flow.workOrderFlow({ companyId: String(w.co._id), workOrderId: String(w.wo._id), asOf: r.generatedAt });
    expect(again.edges).toEqual(r.edges);
  });

  test("historical asOf resolves the version in force across a successor", async () => {
    const w = await world("FlowHistory");
    const t1 = new Date(Date.now() - 5 * 3600e3);
    const t2 = new Date(Date.now() - 2 * 3600e3);
    const { basis: v1 } = await receive(w, { now: t1 });
    const { pub2 } = await republish(w, ["NEW-1", "NEW-2"]);
    await svc(t2).supersede({ companyId: String(w.co._id), workOrderId: String(w.wo._id), publicationId: String(pub2._id),
      supersedesBasisId: String(v1.basisId), reason: "Republished after the IE revision." });
    const flow = createFlowTrackingService();
    const read = (asOf) => flow.workOrderFlow({ companyId: String(w.co._id), workOrderId: String(w.wo._id), asOf });
    expect((await read(new Date(t1.getTime() + 60e3))).operations.map((o) => o.operationCode)).toEqual(["SJ-01", "BA-03", "HM-02"]);
    expect((await read(new Date(t2.getTime() + 60e3))).operations.map((o) => o.operationCode)).toEqual(["NEW-1", "NEW-2"]);
    expect((await read(new Date(t1.getTime() - 60e3))).reasons).toEqual(["production_execution_basis_unavailable"]);
  });

  test("the line view needs this company's line; factoryRef edits change nothing", async () => {
    const w = await world("FlowLine");
    await receive(w, { now: new Date(Date.now() - 3600e3) });
    const flow = createFlowTrackingService();
    await expect(flow.activeFlow({ companyId: String(w.co._id) })).rejects.toMatchObject({ code: "PLANNING_LINE_SCOPE_REQUIRED" });
    const other = await world("FlowLineOther");
    await expect(flow.activeFlow({ companyId: String(w.co._id), capacityLineId: String(other.line._id) }))
      .rejects.toMatchObject({ code: "CAPACITY_LINE_NOT_FOUND" });
    const before = await flow.activeFlow({ companyId: String(w.co._id), capacityLineId: String(w.line._id) });
    expect(before.workOrders.map((x) => x.workOrderId)).toEqual([String(w.wo._id)]);
    await PpcCapacityLine.collection.updateOne({ _id: w.line._id }, { $set: { factoryRef: "SOMEWHERE-ELSE" } });
    const after = await flow.activeFlow({ companyId: String(w.co._id), capacityLineId: String(w.line._id), asOf: before.generatedAt });
    expect(after.workOrders).toEqual(before.workOrders);
    await expect(flow.activeFlow({ companyId: String(w.co._id), capacityLineId: String(w.line._id), zoneId: "LINE NO: 01" }))
      .rejects.toMatchObject({ code: "ZONE_CONTEXT_UNAVAILABLE" }); // no company-owned layout
  });
});

/* ══ 25: THE HTTP BOUNDARY ════════════════════════════════════════════════ */

describe("HTTP boundary: company, department and line isolation", () => {
  test("receipt: 201 then idempotent 200; another company's records are not found; no company → refused", async () => {
    const a = await world("HttpA");
    const b = await world("HttpB");
    const sup = await person({ companies: [a.co] });
    const body = { workOrderId: String(a.wo._id), publicationId: String(a.publication._id),
      // Forged frozen values in the body are ignored: only the selectors are read.
      companyId: String(b.co._id), capacityLineId: String(b.line._id), route: [{ operationCode: "FORGED" }], quantity: 999 };
    const first = await call("/execution-bases/receive", { token: sup.token, method: "POST", body });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ success: true, created: true, executionBasis: {
      versionNo: 1, state: "ACTIVE", reused: false, operationCount: 3, companyId: String(a.co._id), executionQuantity: 10,
      planningLineScope: { capacityLineId: String(a.line._id), lineRef: a.line.lineRef, revision: 3, factoryRefAuthoritative: false },
      siteScope: { status: "not_modelled" }, physicalLineMapping: { status: "unavailable" },
      sources: { ieRelease: { releaseRef: a.release.releaseRef, versionNo: 2 } } } });
    expect(first.body.executionBasis.route).toBeUndefined();
    const replay = await call("/execution-bases/receive", { token: sup.token, method: "POST", body });
    expect(replay.status).toBe(200);
    expect(replay.body.executionBasis.executionBasisId).toBe(first.body.executionBasis.executionBasisId);

    const foreignPub = await call("/execution-bases/receive", { token: sup.token, method: "POST",
      body: { workOrderId: String(a.wo._id), publicationId: String(b.publication._id) } });
    expect([foreignPub.status, foreignPub.body.code]).toEqual([404, "PUBLICATION_NOT_FOUND"]);
    const foreignWo = await call("/execution-bases/receive", { token: sup.token, method: "POST",
      body: { workOrderId: String(b.wo._id), publicationId: String(b.publication._id) } });
    expect([foreignWo.status, foreignWo.body.code]).toEqual([404, "WORK_ORDER_NOT_FOUND"]);
    expect(await basesOf(b.wo._id)).toHaveLength(0);

    const noCompany = await person({ companies: [] });
    expect((await call("/execution-bases/receive", { token: noCompany.token, method: "POST", body })).status).toBeGreaterThanOrEqual(400);
    expect((await call("/execution-bases/receive", { method: "POST", body })).status).toBe(401);
  });

  test("another department cannot receive; a Production viewer grant cannot write", async () => {
    const w = await world("HttpDept");
    const sales = await person({ companies: [w.co], dept: "sales", role: "sales" });
    const body = { workOrderId: String(w.wo._id), publicationId: String(w.publication._id) };
    expect((await call("/execution-bases/receive", { token: sales.token, method: "POST", body })).body.code).toBe("NO_DEPARTMENT_ROLE");
    const viewer = await person({ companies: [w.co], grants: { "production-supervisor": "viewer" } });
    const r = await call("/execution-bases/receive", { token: viewer.token, method: "POST", body });
    expect([r.status, r.body.code]).toEqual([403, "INSUFFICIENT_DEPARTMENT_ROLE"]);
    expect((await call(`/execution-bases/work-orders/${w.wo._id}`, { token: viewer.token })).status).toBe(200);
    expect(await basesOf(w.wo._id)).toHaveLength(0);
  });

  test("flow over HTTP: this company's line only, never another's, never company-wide", async () => {
    const a = await world("HttpFlowA");
    const b = await world("HttpFlowB");
    await receive(a, { now: new Date(Date.now() - 3600e3) });
    await receive(b, { now: new Date(Date.now() - 3600e3) });
    const sup = await person({ companies: [a.co] });
    const own = await call(`/supervisor/flow?capacityLineId=${a.line._id}`, { token: sup.token });
    expect(own.status).toBe(200);
    expect(own.body.workOrders.map((x) => x.workOrderId)).toEqual([String(a.wo._id)]);
    expect(own.body).toMatchObject({ projection: "planning_line", siteScope: { status: "not_modelled" }, physicalLineMapping: { status: "unavailable" } });
    const theirs = await call(`/supervisor/flow?capacityLineId=${b.line._id}`, { token: sup.token });
    expect([theirs.status, theirs.body.code]).toEqual([404, "CAPACITY_LINE_NOT_FOUND"]);
    const companyWide = await call("/supervisor/flow", { token: sup.token });
    expect([companyWide.status, companyWide.body.code]).toEqual([400, "PLANNING_LINE_SCOPE_REQUIRED"]);
    const foreignWo = await call(`/supervisor/flow/work-orders/${b.wo._id}`, { token: sup.token });
    expect([foreignWo.status, foreignWo.body.code]).toEqual([404, "NOT_FOUND"]);
  });
});

/* ══ CROSS-RECORD RACES: A SOURCE CHANGES DURING THE RECEIPT ══════════════ */

/**
 * A service whose first attempt pauses between its (snapshot) reads and its
 * fences, while `change` commits a real, non-transactional write elsewhere.
 */
function interrupted(change) {
  const seen = [];
  const service = createExecutionBasisService({ hooks: { beforeFence: async ({ attempt }) => {
    seen.push(attempt);
    if (attempt === 1) await change();
  } } });
  return { service, seen };
}
const receiveWith = (service, w) => service.receive({ companyId: String(w.co._id), workOrderId: String(w.wo._id),
  publicationId: String(w.publication._id), actor: { name: "Supervisor" } });

describe("a source that stops being eligible during the receipt never yields a basis", () => {
  test.each([
    ["the publication is superseded", (w) => PpcStagePublication.collection.updateOne({ _id: w.publication._id },
      { $set: { isCurrent: false, state: "SUPERSEDED" } }), "PUBLICATION_NOT_CURRENT"],
    ["the booking is released", (w) => PpcCapacityBooking.collection.updateOne({ _id: w.booking._id },
      { $set: { state: "RELEASED" } }), "CAPACITY_BOOKING_INACTIVE"],
    ["the booking is superseded", (w) => PpcCapacityBooking.collection.updateOne({ _id: w.booking._id },
      { $set: { state: "SUPERSEDED" } }), "CAPACITY_BOOKING_INACTIVE"],
    ["the capacity-line revision changes", (w) => PpcCapacityLine.collection.updateOne({ _id: w.line._id },
      { $inc: { revision: 1 } }), "CAPACITY_LINE_REVISION_MISMATCH"],
    ["the IE release is withdrawn", (w) => IeRelease.collection.updateOne({ _id: w.release._id },
      { $set: { state: "WITHDRAWN" } }), "IE_RELEASE_WITHDRAWN"],
    ["the WorkOrder quantity changes", (w) => WorkOrder.collection.updateOne({ _id: w.wo._id },
      { $set: { quantity: 11 } }), "QUANTITY_INCOMPATIBLE"],
  ])("%s → the attempt aborts, the retry re-reads and refuses", async (_label, change, code) => {
    const w = await world(`Race ${_label}`);
    const { service, seen } = interrupted(() => change(w));
    await expect(receiveWith(service, w)).rejects.toMatchObject({ code });
    expect(seen).toEqual([1]); // attempt 1 reached the fence; attempt 2 re-read and refused before it
    expect(await basesOf(w.wo._id)).toHaveLength(0);
    // Nothing the aborted attempt fenced survived.
    expect((await PpcStagePublication.collection.findOne({ _id: w.publication._id }))[RECEIPT_FENCE_FIELD]).toBeUndefined();
  });

  test("a harmless concurrent edit is retried safely, and the basis copies the state it fenced", async () => {
    const w = await world("RaceBenign");
    const { service, seen } = interrupted(() => PpcCapacityLine.collection.updateOne({ _id: w.line._id }, { $set: { name: "Renamed mid-receipt" } }));
    const { basis, reused } = await receiveWith(service, w);
    expect(reused).toBe(false);
    expect(seen).toEqual([1, 2]);
    expect(basis.planningLine.lineName).toBe("Renamed mid-receipt");
    expect((await basesOf(w.wo._id))[0].planningLine.lineName).toBe("Renamed mid-receipt");
  });

  test("the fences commit with the basis, touch no business field and no updatedAt", async () => {
    const w = await world("FenceTouch");
    const beforePub = await PpcStagePublication.collection.findOne({ _id: w.publication._id });
    await receive(w);
    for (const [Model, id] of [[PpcStagePublication, w.publication._id], [PpcCapacityBooking, w.booking._id], [PpcCapacityLine, w.line._id], [IeRelease, w.release._id]]) {
      expect((await Model.collection.findOne({ _id: id }))[RECEIPT_FENCE_FIELD]).toBe(1);
    }
    const afterPub = await PpcStagePublication.collection.findOne({ _id: w.publication._id });
    const { [RECEIPT_FENCE_FIELD]: _fence, ...rest } = afterPub;
    expect(rest).toEqual(beforePub);
  });

  test("a source that keeps changing exhausts the bounded retry with a stable code", async () => {
    const w = await world("RaceForever");
    let n = 0;
    const service = createExecutionBasisService({ hooks: { beforeFence: () => PpcCapacityLine.collection.updateOne(
      { _id: w.line._id }, { $set: { name: `churn ${++n}` } }) } });
    await expect(receiveWith(service, w)).rejects.toMatchObject({ code: "EXECUTION_BASIS_SOURCE_CHANGED", status: 409 });
    expect(n).toBe(MAX_ATTEMPTS);
    expect(await basesOf(w.wo._id)).toHaveLength(0);
  });
});

/* ══ HISTORICAL FLOW WHEN THE PLANNING LINE MOVES OR DISAPPEARS ═══════════ */

describe("historical flow does not depend on today's planning-line record", () => {
  const lineFlow = (w, asOf, lineId = w.line._id) => createFlowTrackingService()
    .activeFlow({ companyId: String(w.co._id), capacityLineId: String(lineId), asOf });

  test("deleted, retired, and edited lines: frozen per-basis scope stays, current is only enrichment", async () => {
    const w = await world("HistLine");
    await receive(w, { now: new Date(Date.now() - 3600e3) });
    const asOf = new Date();
    const before = await lineFlow(w, asOf);
    expect(before.planningLineScope).toMatchObject({ proof: "production_execution_basis", currentRecordStatus: "available",
      current: { lineRef: w.line.lineRef, revision: 3 } });

    await PpcCapacityLine.collection.updateOne({ _id: w.line._id }, { $set: { revision: 7, name: "New name", factoryRef: "UNIT-9" } });
    const edited = await lineFlow(w, asOf);
    expect(edited.workOrders).toEqual(before.workOrders);
    expect(edited.workOrders[0].planningLineScope).toMatchObject({ source: "frozen_execution_basis", revision: 3, factoryRefDisplay: "UNIT-1" });
    expect(edited.planningLineScope.current).toMatchObject({ revision: 7, name: "New name", factoryRefDisplay: "UNIT-9", factoryRefAuthoritative: false });

    await PpcCapacityLine.collection.updateOne({ _id: w.line._id }, { $set: { status: "RETIRED" } });
    const retired = await lineFlow(w, asOf);
    expect(retired.planningLineScope.currentRecordStatus).toBe("retired");
    expect(retired.workOrders).toEqual(before.workOrders);

    await PpcCapacityLine.collection.deleteOne({ _id: w.line._id });
    const deleted = await lineFlow(w, asOf);
    expect(deleted.planningLineScope).toEqual({ capacityLineId: String(w.line._id), proof: "production_execution_basis",
      currentRecordStatus: "missing", current: null });
    expect(deleted.workOrders).toEqual(before.workOrders);
  });

  test("work orders whose bases froze different revisions of one line each keep their own", async () => {
    const first = await world("HistRevA");
    await receive(first, { now: new Date(Date.now() - 7200e3) });
    await PpcCapacityLine.collection.updateOne({ _id: first.line._id }, { $set: { revision: 4 } });
    const second = await world("HistRevB", { co: first.co, line: { ...first.line, revision: 4 } });
    await receive(second, { now: new Date(Date.now() - 3600e3) });
    const r = await lineFlow(first, new Date());
    const revisions = Object.fromEntries(r.workOrders.map((x) => [x.workOrderId, x.planningLineScope.revision]));
    expect(revisions).toEqual({ [String(first.wo._id)]: 3, [String(second.wo._id)]: 4 });
    expect(r.planningLineScope.current.revision).toBe(4);
  });

  test("probing: another company's deleted line and a line nobody used both answer the same 404", async () => {
    const theirs = await world("HistProbeTheirs");
    await receive(theirs, { now: new Date(Date.now() - 3600e3) });
    await PpcCapacityLine.collection.deleteOne({ _id: theirs.line._id });
    const mine = await world("HistProbeMine");
    for (const id of [theirs.line._id, new ObjectId()]) {
      await expect(lineFlow(mine, new Date(), id)).rejects.toMatchObject({ status: 404, code: "CAPACITY_LINE_NOT_FOUND" });
    }
  });
});

/* ══ SUCCESSOR REPLAYS MUST BE THE SAME COMMAND ═══════════════════════════ */

describe("an idempotent successor replay is accepted only when equivalent", () => {
  const REASON = "Republished by PPC after replanning.";
  async function withSuccessor(label) {
    const w = await world(label);
    const { basis: v1 } = await receive(w);
    const { pub2 } = await republish(w);
    const args = { companyId: String(w.co._id), workOrderId: String(w.wo._id), publicationId: String(pub2._id),
      supersedesBasisId: String(v1.basisId), reason: REASON };
    return { w, v1, pub2, args };
  }

  test("exact and whitespace-normalised replays return the stored successor", async () => {
    const { w, args } = await withSuccessor("EqExact");
    const first = await svc().supersede(args);
    const exact = await svc().supersede({ ...args, actor: { name: "A different delivery retry" } });
    const spaced = await svc().supersede({ ...args, reason: "  Republished   by\n PPC after\treplanning.  " });
    expect([exact.reused, spaced.reused]).toEqual([true, true]);
    expect(String(exact.basis.basisId)).toBe(String(first.basis.basisId));
    expect(String(spaced.basis.basisId)).toBe(String(first.basis.basisId));
    const bases = await basesOf(w.wo._id);
    expect(bases).toHaveLength(2);
    expect(bases[0].supersedeReason).toBe(REASON);
    expect(bases[1].receiptCommand).toMatchObject({ kind: "supersede", reasonNormalized: REASON });
  });

  test("a replay naming another predecessor or another reason is refused and changes nothing", async () => {
    const { w, args } = await withSuccessor("EqDiff");
    const { basis: v2 } = await svc().supersede(args);
    const snapshot = await basesOf(w.wo._id);
    for (const diff of [{ supersedesBasisId: String(v2.basisId) }, { supersedesBasisId: String(new ObjectId()) }, { reason: "A completely different reason." }]) {
      await expect(svc().supersede({ ...args, ...diff })).rejects.toMatchObject({ status: 409, code: "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST" });
    }
    // /receive naming the successor's publication is a different command too.
    await rejectsWith(receive(w, { publicationId: args.publicationId }), "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST");
    expect(await basesOf(w.wo._id)).toEqual(snapshot);
  });

  test("concurrent equivalent successors: one basis, every caller gets it", async () => {
    const { w, args } = await withSuccessor("EqConcurrent");
    const results = await Promise.all(Array.from({ length: 5 }, (_, i) => svc().supersede({ ...args, reason: i % 2 ? REASON : ` ${REASON} ` })));
    expect(new Set(results.map((r) => String(r.basis.basisId))).size).toBe(1);
    expect(results.filter((r) => !r.reused)).toHaveLength(1);
    expect(await basesOf(w.wo._id)).toHaveLength(2);
  });

  test("concurrent non-equivalent successors: one wins, the rest are refused, the winner's reason is kept", async () => {
    const { w, args } = await withSuccessor("EqRace");
    const reasons = ["Reason alpha for the replacement.", "Reason bravo for the replacement.", "Reason charlie for the replacement."];
    const outcomes = await Promise.allSettled(reasons.map((reason) => svc().supersede({ ...args, reason })));
    const won = outcomes.filter((o) => o.status === "fulfilled");
    expect(won).toHaveLength(1);
    expect(outcomes.filter((o) => o.status === "rejected").map((o) => o.reason.code))
      .toEqual(["IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST", "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST"]);
    const bases = await basesOf(w.wo._id);
    expect(bases).toHaveLength(2);
    expect(reasons).toContain(bases[0].supersedeReason);
    expect(bases[1].receiptCommand.reasonNormalized).toBe(bases[0].supersedeReason);
  });
});

/* ══ AN UNCERTAIN COMMIT IS RESOLVED BY RECEIPT KEY, NEVER GUESSED ════════ */

const labelled = (label, message = "commit acknowledgement lost") => {
  const e = new Error(message);
  e.hasErrorLabel = (l) => l === label;
  return e;
};
const UNKNOWN = "UnknownTransactionCommitResult";

/**
 * A service whose commit is scripted per call: "commit" really commits,
 * "commit+lose" really commits then loses the acknowledgement, "lose" only
 * loses it, "abort+lose" aborts then reports an unknown result, "fail" aborts
 * definitely, "transient" aborts with TransientTransactionError. `between`
 * runs after an abort, while this request's outcome is still in doubt.
 */
function scripted(script, { between } = {}) {
  const calls = [];
  const fenced = [];
  const service = createExecutionBasisService({
    hooks: { beforeFence: ({ attempt }) => { fenced.push(attempt); } },
    commit: async (session) => {
      const step = script[calls.length] ?? script[script.length - 1];
      calls.push(step);
      if (step === "commit") return session.commitTransaction();
      if (step === "commit+lose") { await session.commitTransaction(); throw labelled(UNKNOWN); }
      if (step === "lose") throw labelled(UNKNOWN);
      if (step === "abort+lose") {
        if (session.inTransaction()) { await session.abortTransaction(); if (between) await between(); }
        throw labelled(UNKNOWN);
      }
      if (step === "transient") { await session.abortTransaction(); throw labelled("TransientTransactionError", "write conflict at commit"); }
      if (step === "fail") { await session.abortTransaction(); throw new Error("commit refused: definite failure"); }
      throw new Error(`unknown step ${step}`);
    },
  });
  return { service, calls, fenced };
}
const args = (w, extra = {}) => ({ companyId: String(w.co._id), workOrderId: String(w.wo._id),
  publicationId: String(w.publication._id), actor: { name: "Supervisor" }, ...extra });

describe("uncertain commit outcomes", () => {
  test("normal success: one commit, created", async () => {
    const w = await world("CommitOk");
    const { service, calls } = scripted(["commit"]);
    const out = await service.receive(args(w));
    expect([out.reused, out.commitOutcome, calls]).toEqual([false, undefined, ["commit"]]);
    expect(await basesOf(w.wo._id)).toHaveLength(1);
  });

  test("the acknowledgement is lost once: the re-sent commit confirms it", async () => {
    const w = await world("AckLostOnce");
    const { service, calls, fenced } = scripted(["commit+lose", "commit"]);
    const out = await service.receive(args(w));
    expect(out.reused).toBe(false);
    expect(calls).toEqual(["commit+lose", "commit"]);
    expect(fenced).toEqual([1]);
    expect(await basesOf(w.wo._id)).toHaveLength(1);
  });

  test("it committed, then every acknowledgement is lost: resolved by receipt key, not rerun", async () => {
    const w = await world("AckLostAlways");
    const { service, calls, fenced } = scripted(["commit+lose", "lose"]);
    const out = await service.receive(args(w));
    expect(out).toMatchObject({ reused: true, commitOutcome: "confirmed_by_receipt_key" });
    expect(calls).toHaveLength(COMMIT_ATTEMPTS);
    expect(fenced).toEqual([1]); // the command was never rerun
    const bases = await basesOf(w.wo._id);
    expect(bases).toHaveLength(1);
    expect(String(bases[0].basisId)).toBe(String(out.basis.basisId));
    // A duplicate client retry afterwards is a plain idempotent replay.
    const again = await receive(w);
    expect([again.reused, String(again.basis.basisId)]).toEqual([true, String(out.basis.basisId)]);
  });

  test("a successor that committed behind lost acknowledgements is returned, predecessor closed", async () => {
    const w = await world("AckLostSucc");
    const { basis: v1 } = await receive(w);
    const { pub2 } = await republish(w);
    const { service, fenced } = scripted(["commit+lose", "lose"]);
    const req = { ...args(w, { publicationId: String(pub2._id) }), supersedesBasisId: String(v1.basisId), reason: "Republished after IE revision." };
    const out = await service.supersede(req);
    expect(out).toMatchObject({ reused: true, commitOutcome: "confirmed_by_receipt_key" });
    expect(fenced).toEqual([1]);
    const bases = await basesOf(w.wo._id);
    expect(bases.map((b) => [b.versionNo, b.state])).toEqual([[1, "SUPERSEDED"], [2, "ACTIVE"]]);
    // An exact replay (whitespace aside) is still the same command.
    expect((await svc().supersede({ ...req, reason: " Republished  after IE revision. " })).reused).toBe(true);
  });

  test("the key holds a DIFFERENT command: refused, and this request is not reported as applied", async () => {
    const w = await world("AckLostOther");
    const { basis: v1 } = await receive(w);
    const { pub2 } = await republish(w);
    const base = { ...args(w, { publicationId: String(pub2._id) }), supersedesBasisId: String(v1.basisId) };
    // While this request's commit is in doubt (it was in fact aborted), another
    // supersede of the same publication with another reason commits.
    const { service } = scripted(["abort+lose", "lose"], {
      between: () => svc().supersede({ ...base, reason: "The other request's reason." }),
    });
    await expect(service.supersede({ ...base, reason: "This request's own reason." }))
      .rejects.toMatchObject({ status: 409, code: "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST" });
    const bases = await basesOf(w.wo._id);
    expect(bases).toHaveLength(2);
    expect(bases[0].supersedeReason).toBe("The other request's reason.");
  });

  test("no receipt exists and the outcome cannot be established: 503, never 'nothing changed'", async () => {
    const w = await world("AckUnknown");
    const { service, calls, fenced } = scripted(["abort+lose", "lose"]);
    let error;
    await service.receive(args(w)).catch((e) => { error = e; });
    expect(error).toMatchObject({ status: 503, code: "EXECUTION_BASIS_COMMIT_OUTCOME_UNKNOWN",
      details: { receiptKey: receiptKeyOf(w.co._id, w.wo._id, w.publication._id), verification: "receipt_key_not_found" } });
    expect(error.message).not.toMatch(/nothing (was )?changed/i);
    expect(calls).toHaveLength(COMMIT_ATTEMPTS);
    expect(fenced).toEqual([1]); // not rerun
    expect(await basesOf(w.wo._id)).toHaveLength(0);
    // The client repeats the same request: exactly one basis, then a replay.
    const retry = await receive(w);
    const replay = await receive(w);
    expect([retry.reused, replay.reused]).toEqual([false, true]);
    expect(await basesOf(w.wo._id)).toHaveLength(1);
  });

  test("a definite commit failure propagates, writes nothing and is not resolved as unknown", async () => {
    const w = await world("CommitFail");
    const { service, fenced } = scripted(["fail"]);
    await expect(service.receive(args(w))).rejects.toThrow("commit refused: definite failure");
    expect(fenced).toEqual([1]);
    expect(await basesOf(w.wo._id)).toHaveLength(0);
  });

  test("a commit aborted with TransientTransactionError is a clean retry of the whole attempt", async () => {
    const w = await world("CommitTransient");
    const { service, calls, fenced } = scripted(["transient", "commit"]);
    const out = await service.receive(args(w));
    expect(out.reused).toBe(false);
    expect(calls).toEqual(["transient", "commit"]);
    expect(fenced).toEqual([1, 2]);
    expect(await basesOf(w.wo._id)).toHaveLength(1);
  });

  test("over HTTP: 503 with the stable code, and 200 with commitOutcome when resolved", async () => {
    const { createExecutionBasisRouter } = require("../../routes/CMS_Routes/Production/ExecutionBasis/executionBasisRoutes");
    const w = await world("AckHttp");
    let service = scripted(["abort+lose", "lose"]).service;
    const app = express();
    app.use(express.json());
    app.use("/eb", createExecutionBasisRouter({
      authenticate: (req, _res, next) => { req.user = { id: String(new ObjectId()), name: "Sup" }; next(); },
      resolveCompany: (req, _res, next) => { req.merchandising = { companyId: String(w.co._id) }; next(); },
      requireEditor: (_q, _s, next) => next(),
      requireViewer: (_q, _s, next) => next(),
      service: () => service,
    }));
    const server = await new Promise((r) => { const s2 = app.listen(0, () => r(s2)); });
    try {
      const post = () => fetch(`http://127.0.0.1:${server.address().port}/eb/receive`, { method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workOrderId: String(w.wo._id), publicationId: String(w.publication._id) }) })
        .then(async (r) => ({ status: r.status, body: await r.json() }));
      const unknown = await post();
      expect([unknown.status, unknown.body.code]).toEqual([503, "EXECUTION_BASIS_COMMIT_OUTCOME_UNKNOWN"]);
      expect(unknown.body.message).not.toMatch(/nothing (was )?changed/i);
      service = scripted(["commit+lose", "lose"]).service;
      const resolved = await post();
      expect(resolved.status).toBe(200);
      expect(resolved.body.executionBasis).toMatchObject({ reused: true, commitOutcome: "confirmed_by_receipt_key", versionNo: 1 });
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});

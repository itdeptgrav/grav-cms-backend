// test/production/support/executionBasisFixtures.js
//
// Coherent PPC / IE / WorkOrder fixtures for Production tests, inserted
// through the raw collections (so a test can later edit or delete them as a
// careless writer could). Shared by the execution-basis and machine-assignment
// suites; copied from production-execution-basis.test.js, which keeps its own.
"use strict";

const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const Employee = require("../../../models/Employee");
const { Acc_Company } = require("../../../models/Accountant_model/Acc_MasterModels");
const DepartmentRole = require("../../../models/Access/DepartmentRole");
const SpCompanyMembership = require("../../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const WorkOrder = require("../../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const { PpcStagePublication } = require("../../../models/CMS_Models/PPC/PpcStagePublication");
const { PpcCapacityBooking } = require("../../../models/CMS_Models/PPC/PpcCapacityBooking");
const { PpcCapacityLine } = require("../../../models/CMS_Models/PPC/PpcCapacityLine");
const IeRelease = require("../../../models/CMS_Models/IndustrialEngineering/IeRelease");
const { createExecutionBasisService } = require("../../../services/production/executionBasis/executionBasis.service");

const { ObjectId } = mongoose.Types;
let seq = 0;

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


/**
 * Create every collection these suites write and wait for their index builds.
 * A transaction cannot take a collection lock while that collection is being
 * created or indexed (a 5 ms lock timeout / "catalog changes" write conflict),
 * so a fresh test database must be settled first — live collections already are.
 */
async function settleCollections(extra = []) {
  // Only the collections a Production transaction reads or writes. A failure
  // to initialise one of THESE is a real problem and fails the suite.
  const models = [WorkOrder, PpcStagePublication, PpcCapacityBooking, PpcCapacityLine, IeRelease, ...extra];
  for (const m of models) {
    await m.createCollection().catch((err) => { if (err?.code !== 48 /* NamespaceExists */) throw err; });
    await m.init();
  }
}

const svc = (now) => createExecutionBasisService(now ? { now: () => now } : {});
const receive = (w, extra = {}) => svc(extra.now).receive({ companyId: String(w.co._id), workOrderId: String(w.wo._id),
  publicationId: String(w.publication._id), actor: { id: String(new ObjectId()), name: "Supervisor" }, ...extra });

module.exports = {
  settleCollections,
  person, company, workOrderFor, lineFor, releaseFor, bookingFor, publicationFor, world, republish, receive, svc,
};

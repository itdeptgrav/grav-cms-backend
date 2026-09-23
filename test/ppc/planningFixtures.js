// test/ppc/planningFixtures.js
//
// The frozen inputs the planning-file suites seed, in one place. Seeded as
// records rather than driven through their own applications' routes: the pack,
// the minutes, IE's release and PPC's receipts are accepted, tested
// applications, and what is under test here is PPC's reading of them.
"use strict";

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const Employee = require("../../models/Employee");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const DeptUser = require("../../models/Access/DeptUser");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const ExecutionFile = require("../../models/CMS_Models/Merchandising/ExecutionFile");
const SalesHandoverVersion = require("../../models/CMS_Models/Sales/SalesHandoverVersion");
const { ExecutionPack } = require("../../models/CMS_Models/Merchandising/ExecutionPack");
const { PreProductionMeeting } = require("../../models/CMS_Models/Merchandising/PreProductionMeeting");
const { DownstreamHandoverReceipt } = require("../../models/CMS_Models/PPC/DownstreamHandoverReceipt");
const { IeReleaseReceipt } = require("../../models/CMS_Models/PPC/IeReleaseReceipt");
const IeRelease = require("../../models/CMS_Models/IndustrialEngineering/IeRelease");
const IeStyleFile = require("../../models/CMS_Models/IndustrialEngineering/IeStyleFile");

let seq = 0;
let keySeq = 0;

function server() {
  const state = { base: null, http: null };
  state.start = async () => {
    const app = express();
    app.use(express.json());
    app.use("/api/cms/ppc", require("../../routes/CMS_Routes/PPC/orderBookRoute"));
    await new Promise((r) => { state.http = app.listen(0, r); });
    state.base = `http://127.0.0.1:${state.http.address().port}/api/cms/ppc`;
  };
  state.stop = () => new Promise((r) => state.http.close(r));
  state.call = (p, { method = "GET", body, token, company, key } = {}) =>
    fetch(`${state.base}${p}`, {
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
  return state;
}

const nextKey = () => `ppc-lane-b-${++keySeq}-${Date.now()}`;

async function actor({ companies = [], grants = {} } = {}) {
  const n = ++seq;
  const email = `lb${n}-${Date.now()}@grav.test`;
  const emp = await Employee.create({
    firstName: "P", lastName: `B${n}`, email, biometricId: `LB${n}${Date.now()}`,
    isActive: true, gender: "Other", department: "Tech",
  });
  await DeptUser.create({
    name: "User", email, passwordHash: "x", isAdmin: false, isActive: true,
    departmentId: new mongoose.Types.ObjectId(), employeeRef: emp._id,
  });
  for (const co of companies) {
    await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: emp._id, personName: "P" });
  }
  for (const [departmentSlug, role] of Object.entries(grants)) {
    await DepartmentRole.create({
      departmentSlug, email, name: "User", role, isActive: true,
      departmentId: new mongoose.Types.ObjectId(),
    });
  }
  const name = `Planner B${n}`;
  return {
    email, name, id: String(emp._id),
    token: jwt.sign(
      { id: String(emp._id), email, name, role: "employee", employeeId: emp.biometricId },
      process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" },
    ),
  };
}

const company = async (label) => Acc_Company.create({
  companyName: `${label} ${++seq}`, booksFromDate: new Date("2026-04-01"),
});

/* Sales' approved handover version of the line — the record the execution
   pack names and PPC's route-applicability proof reads. */
async function orderLine(co, { lineRef, quantity = 500, deliveryDate = "2026-11-20", sampleStyleId = null, processRequirements } = {}) {
  const n = ++seq;
  const projection = {
    orderRef: "ORD-B", orderLineRef: lineRef, styleRef: "Tee", productName: "Tee",
    sampleStyleId: sampleStyleId || new mongoose.Types.ObjectId(),
    buyerDisplayLabel: "Northwind Apparel", brandDisplayLabel: "Northwind",
    totalQuantity: quantity,
    breakdown: [{ lineSplitRef: `${lineRef}-S1`, sizeRange: "S-XL", quantity,
      attributes: [{ name: "Colour", value: "Navy" }] }],
    deliveries: [{ dropRef: `${lineRef}-D1`, committedDeliveryDate: new Date(deliveryDate), quantity }],
    deliveryRequirement: "Sea freight.",
    ...(processRequirements ? { processRequirements } : {}),
  };
  const handover = await SalesHandoverVersion.create({
    companyId: co._id, handoverRef: "ORD-B", handoverLineRef: lineRef, versionNo: 1,
    sourceRecord: { app: "sales", recordType: "customer_request", recordId: new mongoose.Types.ObjectId(),
      sourceVersion: "2026-08-30T00:00:00.000Z", issuedAt: new Date("2026-08-30") },
    executionProjection: projection,
  });
  return ExecutionFile.create({
    fileNumber: `EF-B${n}-${lineRef}`,
    companyId: co._id,
    handoverRef: "ORD-B",
    handoverLineRef: lineRef,
    currentHandoverVersionId: handover._id,
    lifecycleStatus: "OPEN",
    currentExecutionProjection: projection,
  });
}

async function pack(co, file, { versionNo = 1, state = "SUBMITTED", accepted = true } = {}) {
  const named = await SalesHandoverVersion.findById(file.currentHandoverVersionId).select({ versionNo: 1 }).lean();
  const doc = await ExecutionPack.create({
    companyId: co._id, fileId: file._id, packVersionNo: versionNo, state,
    contents: { salesHandover: {
      versionId: file.currentHandoverVersionId, versionNo: named?.versionNo ?? 1,
      handoverRef: file.handoverRef, handoverLineRef: file.handoverLineRef, acceptedAt: new Date("2026-08-31"),
    } },
    completeness: { allPassed: true }, submittedAt: new Date("2026-09-01"),
  });
  await ExecutionFile.updateOne({ _id: file._id }, { $set: { currentPackVersionNo: versionNo } });
  const receipt = accepted ? await DownstreamHandoverReceipt.create({
    companyId: co._id, packId: doc._id, packVersionNo: versionNo, fileId: file._id,
    state: "ACCEPTED", decidedAt: new Date("2026-09-02"),
    decidedBy: { id: new mongoose.Types.ObjectId(), name: "PPC" },
  }) : null;
  return { pack: doc, receipt };
}

/**
 * Issued minutes, carrying the source snapshot Merchandising's own capture
 * would have taken.
 *
 * The snapshot matters as much as the record: PPC compares WHICH engineering
 * release the meeting reviewed against the one its plan freezes, and a minute
 * with no snapshot is legacy evidence that refuses a new plan. So this
 * resolves the style's current issued release AT CALL TIME and records it
 * under the current contract — which means a world must create its release
 * before its minutes, exactly as a real meeting reviews a release that exists.
 *
 * `contractVersion: null` produces a legacy minute deliberately, for the
 * suites that test what happens to one.
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
    companyId: co._id, fileId: file._id, fileNumber: file.fileNumber,
    handoverRef: file.handoverRef, handoverLineRef: file.handoverLineRef,
    orderRef: file.handoverRef, orderLineRef: file.handoverLineRef,
    ppmRef: `PPM-B${n}`, versionNo, state, issuedAt: new Date("2026-09-03"),
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

/* `processRoute`: the IE process route as a frozen release carries it
   (`source.processRoute.stages`), for tests of PPC's stage schedule. */
async function release(co, sampleStyleId, { versionNo = 1, state = "ISSUED", accepted = true, releaseRef, processRoute = null } = {}) {
  const n = ++seq;
  /* IE's own style file for this style, because IE publishes a style's
     current release THROUGH it — a release seeded without one is a record no
     other application can resolve, which is not a state the real system
     produces. Merchandising's meeting capture reads exactly that contract. */
  const styleFile = await IeStyleFile.findOneAndUpdate(
    { companyId: co._id, sampleStyleId },
    { $setOnInsert: { source: { technicalRevision: 1, operationCount: 1, snapshot: null } } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  const doc = await IeRelease.create({
    companyId: co._id,
    releaseRef: releaseRef || `IEREL-B${String(n).padStart(9, "0")}`,
    versionNo,
    ieStyleFileId: styleFile._id,
    sampleStyleId,
    state,
    aggregateFingerprint: `${n}`.padStart(64, "f"),
    source: {
      bulletinVersionId: new mongoose.Types.ObjectId(), bulletinVersionNo: 1,
      sourceFingerprint: `${n}`.padStart(64, "a"), rows: [],
      garmentSamMinutes: 4.5, samRowCount: 4,
      lineLayout: { stationCount: 2, stations: [], metrics: { stationCount: 2 } },
      capacityStandard: {
        inputs: { plannedOperatorCount: 25 }, calculation: { targetPiecesPerDay: 100 },
        readiness: { state: "PROVISIONAL", ready: false, gaps: [] },
      },
      capturedAt: new Date("2026-09-01"),
      ...(processRoute ? { processRoute: { stages: processRoute } } : {}),
    },
    issuedBy: new mongoose.Types.ObjectId(), issuedByName: "IE", issuedAt: new Date("2026-09-01"),
  });
  const receipt = accepted ? await IeReleaseReceipt.create({
    companyId: co._id, releaseRef: doc.releaseRef, releaseVersionNo: versionNo,
    ieReleaseId: doc._id, ieStyleFileId: doc.ieStyleFileId,
    state: "ACCEPTED", decidedAt: new Date("2026-09-02"),
    decidedBy: { id: new mongoose.Types.ObjectId(), name: "PPC" },
    idempotencyKey: `kb-${n}`, requestHash: `hb-${n}`,
  }) : null;
  return { release: doc, receipt };
}

/** A company with PPC people and one fully ready line. */
async function readyWorld(label, { packAccepted = true, releaseAccepted = true, processRoute = null, co: given = null } = {}) {
  const co = given || await company(label);
  const file = await orderLine(co, { lineRef: `L-${label}-${++seq}` });
  const styleId = file.currentExecutionProjection.sampleStyleId;
  const p = await pack(co, file, { accepted: packAccepted });
  /* The release first: a meeting reviews engineering that already exists, and
     the minutes record WHICH release that was. */
  const r = await release(co, styleId, { accepted: releaseAccepted, processRoute });
  await minutes(co, file);
  return {
    co, file, styleId,
    pack: p.pack, packReceipt: p.receipt,
    rel: r.release, ieReceipt: r.receipt,
    lineRef: file.handoverLineRef,
    viewer: await actor({ companies: [co], grants: { ppc: "viewer" } }),
    planner: await actor({ companies: [co], grants: { ppc: "editor" } }),
    approver: await actor({ companies: [co], grants: { ppc: "approver" } }),
  };
}

/**
 * IE's approved cutting standard, as a route stage carries it.
 *
 * Every world whose route requires CUTTING needs one, because a cutting stage
 * with no standard cannot be dated — which is the contract under test in
 * test/ppc/ppc-cutting-technical-basis.test.js and is exactly what a real
 * approved route for a cut garment would carry.
 */
const cuttingStandard = (over = {}) => ({
  kind: "CUTTING_SAM",
  standardMinutesPerPiece: 0.8,
  standardUnit: "MINUTES_PER_PIECE",
  setupMinutesPerOrder: 45,
  setupUnit: "MINUTES_PER_ORDER",
  resourceType: "STRAIGHT_KNIFE",
  resourceLabel: "",
  basis: "24-ply lay, 1.6m marker, cotton jersey.",
  source: { method: "TIME_STUDY", reference: "TS-2026-014" },
  declaredAt: new Date("2026-09-01"),
  declaredByName: "IE",
  ...over,
});

module.exports = {
  cuttingStandard,
  server, nextKey, actor, company, orderLine, pack, minutes, release, readyWorld, SalesHandoverVersion,
};

// Add a clearly marked PPC walkthrough to the existing GRAV company.
// Dry-run by default. This script never deletes or alters non-demo records.
"use strict";

require("dotenv/config");
const { createHash, randomUUID } = require("crypto");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");

const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const DeptUser = require("../../models/Access/DeptUser");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const ExecutionFile = require("../../models/CMS_Models/Merchandising/ExecutionFile");
const { ExecutionPack } = require("../../models/CMS_Models/Merchandising/ExecutionPack");
const { PreProductionMeeting } = require("../../models/CMS_Models/Merchandising/PreProductionMeeting");
const IeRelease = require("../../models/CMS_Models/IndustrialEngineering/IeRelease");
const { IeReleaseReceipt } = require("../../models/CMS_Models/PPC/IeReleaseReceipt");
const { DownstreamHandoverReceipt } = require("../../models/CMS_Models/PPC/DownstreamHandoverReceipt");
const { PpcPlanningFile } = require("../../models/CMS_Models/PPC/PpcPlanningFile");
const { PpcCapacityCalendar, PpcCapacityCalendarVersion } = require("../../models/CMS_Models/PPC/PpcCapacityCalendar");
const { PpcCapacityLine } = require("../../models/CMS_Models/PPC/PpcCapacityLine");
const { PpcCapacityBooking } = require("../../models/CMS_Models/PPC/PpcCapacityBooking");

const COMPANY_NAME = "GRAV CLOTHING PVT LTD";
const COMPANY_ID = "6a08040a1fecacc9bb7149c2";
const ACTOR_EMAIL = "ceo@grav.in";
const PREFIX = "PPC-DEMO-2026";
const API = "http://127.0.0.1:5050/api/cms/ppc";
const EXAMPLES = [
  { key: "AWAITING", style: "Linen resort shirt", buyer: "Northstar Apparel", qty: 750 },
  { key: "READY", style: "Cotton jersey polo", buyer: "Harbor & Co", qty: 1200 },
  { key: "PLANNING", style: "Utility overshirt", buyer: "Northstar Apparel", qty: 640 },
  { key: "PLANNED", style: "Relaxed twill trouser", buyer: "Fieldline", qty: 980 },
  { key: "BOOKED", style: "Ribbed knit cardigan", buyer: "Harbor & Co", qty: 520 },
  { key: "HOLD", style: "Washed denim jacket", buyer: "Fieldline", qty: 410 },
];
const oid = () => new mongoose.Types.ObjectId();
const digest = (value) => createHash("sha256").update(value).digest("hex");
const day = (offset) => {
  const d = new Date();
  d.setUTCHours(12, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};

async function api(path, token, companyId, { method = "GET", body, key } = {}) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "X-Costing-Company": String(companyId),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let payload;
  try { payload = JSON.parse(text); } catch { throw new Error(`${method} ${path}: non-JSON ${response.status}`); }
  if (!response.ok || payload?.success === false) {
    throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(payload)}`);
  }
  return payload;
}

function technicalSource(key) {
  const operations = [
    ["FRONT-JOIN", "Join front panels", "SNLS", 1.1],
    ["COLLAR", "Attach collar", "SNLS", 1.2],
    ["SLEEVE", "Set sleeves", "SNLS", 1.3],
    ["HEM-CHECK", "Hem and seam check", "Overlock", 0.9],
  ];
  const rows = operations.map(([code, name, machine, minutes], i) => ({
    rowId: `${key}-OP-${i + 1}`, sequence: i + 1, ieOperationId: oid(), ieOperationRevision: 1,
    operationCode: code, operationName: name, machineType: machine,
    standardTimeMinutes: minutes, standardTimeSource: "PPC DEMO ONLY",
  }));
  const stations = rows.map((row, i) => ({
    stationId: `${key}-ST-${i + 1}`, sequence: i + 1,
    label: `Station ${i + 1} · ${row.operationName}`,
    plannedMachineTypes: [{ machineType: row.machineType, quantity: 1 }],
    assignments: [{ rowId: row.rowId, sequence: 1, operationCode: row.operationCode,
      standardTimeMinutes: row.standardTimeMinutes }],
  }));
  return {
    bulletinVersionId: oid(), bulletinVersionNo: 1,
    sourceFingerprint: digest(`${PREFIX}-${key}-bulletin`),
    rows, garmentSamMinutes: 4.5, samRowCount: rows.length,
    samDerivation: "Illustrative PPC demo standard; not an approved factory study",
    lineLayout: {
      stationCount: stations.length, stations,
      metrics: { stationCount: stations.length, totalWorkContentMinutes: 4.5,
        pitchMinutes: 1.3, bottleneckMinutes: 1.3,
        balanceEfficiencyPercent: 86.54, balanceLossPercent: 13.46 },
    },
    capacityStandard: {
      inputs: { plannedOperatorCount: 24, targetEfficiencyPercent: 65,
        availableShiftMinutes: 540, breakMinutes: 60, shiftsPerDay: 1 },
      calculation: { targetPiecesPerDay: 90 },
      readiness: { state: "PROVISIONAL", ready: false, gaps: [] },
    },
    capturedAt: new Date(),
  };
}

async function ensureOrder(company, example, index) {
  const lineRef = `${PREFIX}-${example.key}`;
  let file = await ExecutionFile.findOne({ companyId: company._id, handoverLineRef: lineRef });
  if (file) return file;
  file = await ExecutionFile.create({
    fileNumber: `${PREFIX}-EF-${example.key}`, companyId: company._id,
    handoverRef: `${PREFIX}-ORDER`, handoverLineRef: lineRef,
    currentHandoverVersionId: oid(), lifecycleStatus: "OPEN",
    currentExecutionProjection: {
      orderRef: `${PREFIX}-ORDER-${String(index + 1).padStart(3, "0")}`,
      orderLineRef: lineRef, styleRef: `${PREFIX}-STYLE-${index + 1}`,
      productName: example.style, sampleStyleId: oid(),
      buyerDisplayLabel: example.buyer, brandDisplayLabel: "PPC DEMO",
      totalQuantity: example.qty,
      breakdown: [{ lineSplitRef: `${lineRef}-S1`, sizeRange: "S-XL", quantity: example.qty,
        attributes: [{ name: "Colour", value: "Navy" }] }],
      deliveries: [{ dropRef: `${lineRef}-D1`, committedDeliveryDate: new Date(day(35 + index * 7)),
        quantity: example.qty }],
      deliveryRequirement: "Illustrative PPC demo order; not a buyer commitment.",
    },
  });
  return file;
}

async function ensureInputs(company, file, example, actor) {
  const companyId = company._id;
  if (example.key !== "AWAITING") {
    let pack = await ExecutionPack.findOne({ companyId, fileId: file._id, packVersionNo: 1 });
    if (!pack) pack = await ExecutionPack.create({ companyId, fileId: file._id,
      packVersionNo: 1, state: "SUBMITTED", completeness: { allPassed: true },
      submittedAt: new Date() });
    if (file.currentPackVersionNo !== 1) {
      await ExecutionFile.updateOne({ _id: file._id, companyId }, { $set: { currentPackVersionNo: 1 } });
    }
    if (!await DownstreamHandoverReceipt.exists({ companyId, packId: pack._id, state: "ACCEPTED" })) {
      await DownstreamHandoverReceipt.create({ companyId, packId: pack._id,
        packVersionNo: 1, fileId: file._id, state: "ACCEPTED", decidedAt: new Date(),
        decidedBy: { id: actor._id, name: "PPC demo setup" } });
    }
    if (!await PreProductionMeeting.exists({ companyId, fileId: file._id, versionNo: 1 })) {
      await PreProductionMeeting.create({ companyId, fileId: file._id,
        fileNumber: file.fileNumber, handoverRef: file.handoverRef,
        handoverLineRef: file.handoverLineRef, orderRef: file.currentExecutionProjection.orderRef,
        orderLineRef: file.handoverLineRef, ppmRef: `${PREFIX}-PPM-${example.key}`,
        versionNo: 1, state: "ISSUED", issuedAt: new Date() });
    }
  }
  const releaseRef = `${PREFIX}-IE-${example.key}`;
  let release = await IeRelease.findOne({ companyId, releaseRef, versionNo: 1 });
  if (!release) release = await IeRelease.create({ companyId, releaseRef, versionNo: 1,
    ieStyleFileId: oid(), sampleStyleId: file.currentExecutionProjection.sampleStyleId,
    state: "ISSUED", aggregateFingerprint: digest(`${releaseRef}-aggregate`),
    source: technicalSource(example.key), issuedBy: actor._id,
    issuedByName: "PPC demo · illustrative IE", issuedAt: new Date(),
    note: "PPC DEMO ONLY — illustrative technical release, not an actual IE approval.",
  });
  if (example.key !== "AWAITING" &&
      !await IeReleaseReceipt.exists({ companyId, ieReleaseId: release._id, state: "ACCEPTED" })) {
    await IeReleaseReceipt.create({ companyId, releaseRef, releaseVersionNo: 1,
      ieReleaseId: release._id, ieStyleFileId: release.ieStyleFileId,
      state: "ACCEPTED", decidedAt: new Date(),
      decidedBy: { id: actor._id, name: "PPC demo setup" },
      idempotencyKey: randomUUID(), requestHash: randomUUID() });
  }
}

async function ensurePlan(company, example, token) {
  if (["AWAITING", "READY"].includes(example.key)) return null;
  const companyId = company._id;
  const lineRef = `${PREFIX}-${example.key}`;
  let plan = await PpcPlanningFile.findOne({ companyId, orderLineRef: lineRef });
  if (!plan) {
    const created = await api(`/order-book/${encodeURIComponent(lineRef)}/planning-file`, token, companyId,
      { method: "POST", body: {}, key: randomUUID() });
    plan = await PpcPlanningFile.findById(created.planningFile.planningFileId);
  }
  if (plan.state === "OPEN") {
    const started = await api(`/planning-files/${plan._id}/planning-started`, token, companyId,
      { method: "POST", body: { expectedRevision: plan.revision }, key: randomUUID() });
    plan = await PpcPlanningFile.findById(started.planningFile.planningFileId);
  }
  if (example.key === "HOLD" && plan.state !== "ON_HOLD") {
    const held = await api(`/planning-files/${plan._id}/hold`, token, companyId,
      { method: "POST", body: { expectedRevision: plan.revision,
        reason: "AWAITING_MATERIAL", note: "PPC DEMO: fabric confirmation pending" }, key: randomUUID() });
    return PpcPlanningFile.findById(held.planningFile.planningFileId);
  }
  if (["PLANNED", "BOOKED"].includes(example.key) && plan.state !== "PLANNED") {
    const planned = await api(`/planning-files/${plan._id}/planned`, token, companyId,
      { method: "POST", body: { expectedRevision: plan.revision }, key: randomUUID() });
    return PpcPlanningFile.findById(planned.planningFile.planningFileId);
  }
  return plan;
}

async function ensureCapacity(company, token, bookedPlan) {
  const companyId = company._id;
  const calendarRef = `${PREFIX}-WEEK`;
  let calendar = await PpcCapacityCalendar.findOne({ companyId, calendarRef });
  if (!calendar) {
    const created = await api("/capacity/calendars", token, companyId, { method: "POST",
      body: { calendarRef, name: "PPC demo working week", timezone: "Asia/Kolkata" } });
    calendar = await PpcCapacityCalendar.findById(created.calendar.calendarId);
  }
  const publishedVersion = await PpcCapacityCalendarVersion.exists({
    companyId, calendarId: calendar._id, state: "PUBLISHED",
  });
  if (!publishedVersion) {
    const weekPattern = [0, 1, 2, 3, 4, 5, 6].map((n) => n < 6
      ? { working: true, shifts: [{ shiftKey: "A", start: "08:00", end: "17:00", breakMinutes: 60 }] }
      : { working: false, shifts: [] });
    const version = await api(`/capacity/calendars/${calendar._id}/versions`, token, companyId,
      { method: "POST", body: { validFrom: "2026-01-01", validTo: null, weekPattern, exceptions: [] } });
    await api(`/capacity/calendar-versions/${version.version.versionId}/publish`, token, companyId,
      { method: "POST", body: { expectedRevision: 1 }, key: randomUUID() });
  }
  const lineRef = `${PREFIX}-LINE-A`;
  let line = await PpcCapacityLine.findOne({ companyId, lineRef });
  if (!line) {
    const created = await api("/capacity/lines", token, companyId, { method: "POST", body: {
      lineRef, name: "PPC demo sewing line A", factoryRef: "DEMO-UNIT-1",
      calendarId: String(calendar._id), operatorCount: 24,
    } });
    line = await PpcCapacityLine.findById(created.line.lineId);
  }
  if (await PpcCapacityBooking.exists({ companyId, planningFileId: bookedPlan._id, state: "ACTIVE" })) {
    return;
  }
  const windowStart = day(2); const windowEnd = day(11);
  const preview = await api("/capacity/preview", token, companyId, { method: "POST",
    body: { planningFileId: String(bookedPlan._id), lineId: String(line._id), windowStart, windowEnd } });
  if (!preview.preview?.bookable) {
    throw new Error(`PPC demo booking cannot be made: ${JSON.stringify(preview.preview?.blockers || preview.preview)}`);
  }
  await api("/capacity/bookings", token, companyId, { method: "POST", key: randomUUID(),
    body: { planningFileId: String(bookedPlan._id), lineId: String(line._id),
      windowStart, windowEnd, expected: preview.preview.proof } });
}

async function main() {
  if (!process.env.MONGODB_URI || !process.env.JWT_SECRET) throw new Error("Main database and JWT configuration required");
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
  try {
    if (mongoose.connection.name !== "test") throw new Error("Refusing unexpected database");
    const company = await Acc_Company.findById(COMPANY_ID);
    if (!company || company.companyName !== COMPANY_NAME) throw new Error("GRAV company identity did not match");
    const actor = await DeptUser.findOne({ email: ACTOR_EMAIL, isActive: true });
    const grant = await DepartmentRole.findOne({ email: ACTOR_EMAIL,
      departmentSlug: "ppc", role: "owner", isActive: true });
    const member = await SpCompanyMembership.findOne({ email: ACTOR_EMAIL, companyId: company._id });
    if (!actor || !grant || !member) throw new Error("CEO's PPC owner access is not proven");
    const scope = { companyId: company._id };
    const before = {
      executionFiles: await ExecutionFile.countDocuments(scope),
      planningFiles: await PpcPlanningFile.countDocuments(scope),
      capacityLines: await PpcCapacityLine.countDocuments(scope),
      bookings: await PpcCapacityBooking.countDocuments(scope),
    };
    console.log(JSON.stringify({ database: mongoose.connection.name, company: company.companyName,
      prefix: PREFIX, before, apply: process.argv.includes("--apply") }));
    if (!process.argv.includes("--apply")) return;
    const token = jwt.sign({ id: String(actor._id), email: actor.email, name: actor.name,
      role: "ceo", deptId: String(actor.departmentId || ""), deptSlug: "ceo" },
    process.env.JWT_SECRET, { expiresIn: "15m" });
    const booked = EXAMPLES.find((e) => e.key === "BOOKED");
    let bookedPlan = null;
    for (const [index, example] of EXAMPLES.entries()) {
      const file = await ensureOrder(company, example, index);
      await ensureInputs(company, file, example, actor);
      const plan = await ensurePlan(company, example, token);
      if (example.key === booked.key) bookedPlan = plan;
      console.log(`${example.key}: ${file.fileNumber}${plan ? ` / ${plan.state}` : ""}`);
    }
    await ensureCapacity(company, token, bookedPlan);
    const summary = await api("/order-book/summary", token, company._id);
    const after = {
      executionFiles: await ExecutionFile.countDocuments(scope),
      planningFiles: await PpcPlanningFile.countDocuments(scope),
      capacityLines: await PpcCapacityLine.countDocuments(scope),
      bookings: await PpcCapacityBooking.countDocuments(scope),
    };
    console.log(JSON.stringify({ after, counts: summary.counts,
      demoFiles: await ExecutionFile.countDocuments({ ...scope, handoverLineRef: { $regex: `^${PREFIX}-` } }) }));
  } finally { await mongoose.disconnect(); }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });

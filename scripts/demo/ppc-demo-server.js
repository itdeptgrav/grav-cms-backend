// Local-only PPC showroom. No configured MongoDB or Firebase credentials reach
// the child server. Stop this process and the in-memory data disappears.
"use strict";

const { generateKeyPairSync, randomUUID } = require("crypto");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

const PORT = Number(process.env.PPC_DEMO_PORT || 5198);
const EMAIL = "ppc.demo@grav.local";
const PASSWORD = "DemoPpc2026!";
const id = () => new mongoose.Types.ObjectId();
const date = (offset) => {
  const d = new Date();
  d.setUTCHours(12, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};

async function localRoutes(token, companyId) {
  const app = express();
  app.use(express.json());
  app.use("/api/cms/ppc", require("../../routes/CMS_Routes/PPC/orderBookRoute"));
  app.use("/api/cms/ppc", require("../../routes/CMS_Routes/PPC/capacityRoute"));
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  const base = `http://127.0.0.1:${server.address().port}/api/cms/ppc`;
  const call = async (url, { method = "GET", body, key } = {}) => {
    const response = await fetch(`${base}${url}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Costing-Company": String(companyId),
        "Content-Type": "application/json",
        ...(key ? { "Idempotency-Key": key } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(`${method} ${url}: ${response.status} ${JSON.stringify(payload)}`);
    return payload;
  };
  return { call, close: () => new Promise((resolve) => server.close(resolve)) };
}

async function seed() {
  process.env.SALARY_ENCRYPTION_KEY = "0".repeat(64);
  process.env.JWT_SECRET = "ppc-local-demo-only";
  const fx = require("../../test/ppc/planningFixtures");
  const AccessDepartment = require("../../models/Access/AccessDepartment");
  const DeptUser = require("../../models/Access/DeptUser");
  const DepartmentRole = require("../../models/Access/DepartmentRole");
  const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
  const ExecutionFile = require("../../models/CMS_Models/Merchandising/ExecutionFile");
  const IeRelease = require("../../models/CMS_Models/IndustrialEngineering/IeRelease");
  const { IeReleaseReceipt } = require("../../models/CMS_Models/PPC/IeReleaseReceipt");
  const { PpcPlanningFile } = require("../../models/CMS_Models/PPC/PpcPlanningFile");
  const { PpcCapacityCalendar, PpcCapacityCalendarVersion } = require("../../models/CMS_Models/PPC/PpcCapacityCalendar");
  const { PpcCapacityLine } = require("../../models/CMS_Models/PPC/PpcCapacityLine");
  const { PpcCapacityBooking, PpcCapacityLineDay } = require("../../models/CMS_Models/PPC/PpcCapacityBooking");

  const company = await fx.company("PPC SHOWROOM · LOCAL ONLY");
  const department = await AccessDepartment.create({
    key: "ppc", slug: "ppc", name: "Production Planning", dashboardPath: "/ppc", isActive: true,
  });
  const user = new DeptUser({ name: "PPC Demo Planner", email: EMAIL, departmentId: department._id });
  await user.setPassword(PASSWORD);
  await user.save();
  await DepartmentRole.create({ departmentSlug: "ppc", departmentId: department._id, email: EMAIL, name: user.name, role: "owner" });
  await SpCompanyMembership.create({ companyId: company._id, email: EMAIL, personName: user.name });
  const token = jwt.sign({ id: String(user._id), email: EMAIL, name: user.name,
    role: "ppc", deptId: String(department._id), deptSlug: "ppc" }, process.env.JWT_SECRET,
  { expiresIn: "12h" });

  const examples = [
    { ref: "DEMO-AWAITING", style: "Linen resort shirt", buyer: "Northstar Apparel", qty: 750, phase: "AWAITING" },
    { ref: "DEMO-READY", style: "Cotton jersey polo", buyer: "Harbor & Co", qty: 1200, phase: "READY" },
    { ref: "DEMO-PLANNING", style: "Utility overshirt", buyer: "Northstar Apparel", qty: 640, phase: "PLANNING" },
    { ref: "DEMO-PLANNED", style: "Relaxed twill trouser", buyer: "Fieldline", qty: 980, phase: "PLANNED" },
    { ref: "DEMO-BOOKED", style: "Ribbed knit cardigan", buyer: "Harbor & Co", qty: 520, phase: "BOOKED" },
    { ref: "DEMO-HOLD", style: "Washed denim jacket", buyer: "Fieldline", qty: 410, phase: "HOLD" },
  ];
  const routes = await localRoutes(token, company._id);
  const issueRelease = async (styleId, ordinal, accepted) => {
    const release = await IeRelease.create({
      companyId: company._id, releaseRef: `DEMO-IE-${ordinal}`, versionNo: 1,
      ieStyleFileId: id(), sampleStyleId: styleId, state: "ISSUED",
      aggregateFingerprint: String(ordinal).padStart(64, "f"),
      source: {
        bulletinVersionId: id(), bulletinVersionNo: 1,
        sourceFingerprint: String(ordinal).padStart(64, "a"), rows: [],
        garmentSamMinutes: 4.5, samRowCount: 4,
        lineLayout: { stationCount: 2, stations: [], metrics: { stationCount: 2 } },
        capacityStandard: {
          inputs: { plannedOperatorCount: 24, targetEfficiencyPercent: 65 },
          calculation: { targetPiecesPerDay: 90 },
          readiness: { state: "PROVISIONAL", ready: false, gaps: [] },
        },
        capturedAt: new Date(),
      },
      issuedBy: user._id, issuedByName: "Demo Industrial Engineering", issuedAt: new Date(),
    });
    if (accepted) await IeReleaseReceipt.create({
      companyId: company._id, releaseRef: release.releaseRef, releaseVersionNo: 1,
      ieReleaseId: release._id, ieStyleFileId: release.ieStyleFileId,
      state: "ACCEPTED", decidedAt: new Date(),
      decidedBy: { id: user._id, name: "PPC Demo Planner" },
      idempotencyKey: randomUUID(), requestHash: randomUUID(),
    });
    return release;
  };
  let booked = false;
  try {
    for (let i = 0; i < examples.length; i += 1) {
      const ex = examples[i];
      const file = await fx.orderLine(company, { lineRef: ex.ref, quantity: ex.qty, deliveryDate: date(35 + i * 7) });
      await ExecutionFile.updateOne({ _id: file._id }, { $set: {
        "currentExecutionProjection.productName": ex.style,
        "currentExecutionProjection.styleRef": `STYLE-${i + 1}`,
        "currentExecutionProjection.buyerDisplayLabel": ex.buyer,
        "currentExecutionProjection.orderRef": `DEMO-ORDER-${String(i + 1).padStart(3, "0")}`,
      } });
      if (ex.phase === "AWAITING") {
        await issueRelease(file.currentExecutionProjection.sampleStyleId, i + 1, false);
        continue;
      }
      await fx.pack(company, file);
      await fx.minutes(company, file);
      await issueRelease(file.currentExecutionProjection.sampleStyleId, i + 1, true);
      if (ex.phase === "READY") continue;
      const created = await routes.call(`/order-book/${ex.ref}/planning-file`, {
        method: "POST", body: {}, key: randomUUID(),
      });
      const planId = created.planningFile.planningFileId;
      const started = await routes.call(`/planning-files/${planId}/planning-started`, {
        method: "POST", body: { expectedRevision: created.planningFile.revision }, key: randomUUID(),
      });
      if (ex.phase === "PLANNING") continue;
      if (ex.phase === "HOLD") {
        await routes.call(`/planning-files/${planId}/hold`, { method: "POST", key: randomUUID(),
          body: { expectedRevision: started.planningFile.revision, reason: "AWAITING_MATERIAL", note: "Demo: fabric confirmation pending" } });
        continue;
      }
      const planned = await routes.call(`/planning-files/${planId}/planned`, {
        method: "POST", body: { expectedRevision: started.planningFile.revision }, key: randomUUID(),
      });
      if (ex.phase === "BOOKED") ex.planId = planned.planningFile.planningFileId;
    }

    const weekPattern = [0, 1, 2, 3, 4, 5, 6].map((n) => n < 6
      ? { working: true, shifts: [{ shiftKey: "A", start: "08:00", end: "17:00", breakMinutes: 60 }] }
      : { working: false, shifts: [] });
    const calendar = await routes.call("/capacity/calendars", { method: "POST",
      body: { calendarRef: "DEMO-WEEK", name: "Showroom working week", timezone: "Asia/Kolkata" } });
    const version = await routes.call(`/capacity/calendars/${calendar.calendar.calendarId}/versions`, {
      method: "POST", body: { validFrom: "2026-01-01", validTo: null, weekPattern, exceptions: [] },
    });
    await routes.call(`/capacity/calendar-versions/${version.version.versionId}/publish`, {
      method: "POST", body: { expectedRevision: 1 }, key: randomUUID(),
    });
    const line = await routes.call("/capacity/lines", { method: "POST", body: {
      lineRef: "DEMO-LINE-A", name: "Sewing line A", factoryRef: "UNIT-1",
      calendarId: calendar.calendar.calendarId, operatorCount: 24,
    } });
    const bookingPlan = examples.find((e) => e.phase === "BOOKED");
    const windowStart = date(2); const windowEnd = date(11);
    const preview = await routes.call("/capacity/preview", { method: "POST", body: {
      planningFileId: bookingPlan.planId, lineId: line.line.lineId, windowStart, windowEnd,
    } });
    if (!preview.preview?.bookable) {
      throw new Error(`Demo booking was not bookable: ${JSON.stringify(preview.preview?.blockers || preview.preview)}`);
    }
    await routes.call("/capacity/bookings", { method: "POST", key: randomUUID(), body: {
      planningFileId: bookingPlan.planId, lineId: line.line.lineId, windowStart, windowEnd,
      expected: preview.preview.proof,
    } });
    booked = true;
    const actual = await routes.call("/order-book/summary");
    const expected = { all: 6, "awaiting-inputs": 1, "ready-to-plan": 1,
      planning: 1, planned: 2, blocked: 1 };
    for (const [key, value] of Object.entries(expected)) {
      if (actual.counts?.[key] !== value) throw new Error(`Demo ${key}: expected ${value}, got ${actual.counts?.[key]}`);
    }
    return { company: company.companyName, counts: actual.counts, capacityBooked: booked };
  } finally { await routes.close(); }
}

async function main() {
  const mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  const uri = mongo.getUri("ppc_demo");
  if (!/^mongodb:\/\/(127\.0\.0\.1|localhost):/.test(uri)) throw new Error("Demo MongoDB must bind to loopback");
  process.env.MONGODB_URI = uri;
  await mongoose.connect(uri);
  let child;
  const stop = async () => {
    if (child && !child.killed) child.kill("SIGTERM");
    await mongoose.disconnect();
    await mongo.stop();
    process.exit(0);
  };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  try {
    const outcome = await seed();
    await mongoose.disconnect();
    const source = process.env.PPC_DEMO_BACKEND_DIR;
    if (!source || fs.existsSync(path.join(source, ".env")) || fs.existsSync(path.join(source, ".env.local"))) {
      throw new Error("PPC_DEMO_BACKEND_DIR must name a clean source copy without environment files");
    }
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
    const env = {
      PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "development",
      MONGODB_URI: uri, PORT: String(PORT), JWT_SECRET: "ppc-local-demo-only",
      SALARY_ENCRYPTION_KEY: "0".repeat(64),
      FIREBASE_SERVICE_ACCOUNT: JSON.stringify({ project_id: "grav-local-demo-invalid",
        client_email: "demo@grav-local-demo-invalid.iam.gserviceaccount.com", private_key: privateKey }),
      FIREBASE_DATABASE_URL: "http://127.0.0.1:1",
    };
    child = spawn(process.execPath, ["server.js"], { cwd: source, env, stdio: "inherit" });
    child.once("exit", (code) => { console.error(`PPC demo backend exited (${code})`); void stop(); });
    console.log(`PPC DEMO READY: http://127.0.0.1:${PORT}`);
    console.log(`DEMO DATA: ${JSON.stringify(outcome)}`);
    console.log(`LOGIN: ${EMAIL} / ${PASSWORD}`);
    console.log("IN-MEMORY DATABASE ONLY; stopping this process discards all demo changes.");
  } catch (error) {
    console.error(error);
    await mongoose.disconnect();
    await mongo.stop();
    process.exitCode = 1;
  }
}

if (require.main === module) main();

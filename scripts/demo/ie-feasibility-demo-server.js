// Local-only Engineering Feasibility showroom.
//
// An in-memory MongoDB, a style built through the real IE services, and the real
// server.js on a loopback port. No configured MongoDB or Firebase credential
// reaches the child server: the database is this process's own, and the Firebase
// credential handed down names a project that does not exist, so nothing here can
// read or write the shared cluster or the live Firestore. Stop this process and
// every row disappears.
//
// Usage:
//   IE_DEMO_BACKEND_DIR=/path/to/clean/copy node scripts/demo/ie-feasibility-demo-server.js
//
// The backend directory must be a copy of the source with NO .env file, because
// server.js calls dotenv at its second line and would otherwise load the real
// cluster's credentials over the ones passed here.
"use strict";

const { generateKeyPairSync } = require("crypto");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

const { DEMO_ASSESSMENT, ensureDemoAssessment } = require("./ie-feasibility-demo-assessment");

const PORT = Number(process.env.IE_DEMO_PORT || 5199);
/* The demo frontend's own origin. The real CORS list in server.js is code-owned
   and is not edited for a showroom: `EXTRA_ALLOWED_ORIGINS` is the documented
   additive door for exactly this, so the child boots with the same CORS code
   production runs. */
const FRONTEND_PORT = Number(process.env.IE_DEMO_FRONTEND_PORT || 3011);
const PASSWORD = "DemoIe2026!";
const EDITOR = "ie.editor@grav.local";
const APPROVER = "ie.approver@grav.local";
const VIEWER = "ie.viewer@grav.local";

/* The style the demonstration is about. The reference is the one the brief names,
   so a screenshot of this showroom and a screenshot of the real register are
   talking about the same garment. */
const STYLE_CODE = "NW-POLO-26";
const PRODUCT_NAME = "Pique knit polo (demo)";
const TECHNICAL_REVISION = 2;

const id = () => new mongoose.Types.ObjectId();

/** A caller for the IE router, mounted in-process on its own loopback port. */
async function ieRouter() {
  const app = express();
  app.use(express.json());
  app.use("/api/cms/ie", require("../../routes/CMS_Routes/IndustrialEngineering/ieRoutes"));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}/api/cms/ie`;
  const caller = (token, companyId) => async (url, { method = "GET", body } = {}) => {
    const r = await fetch(`${base}${url}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Costing-Company": String(companyId),
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await r.text();
    let parsed = null;
    try { parsed = JSON.parse(text || "null"); } catch { parsed = { nonJson: text.slice(0, 200) }; }
    return { status: r.status, body: parsed };
  };
  /* Loud, for the setup chain: a step that failed quietly would surface much
     later as a style that cannot be submitted, for no visible reason. */
  const must = (call) => async (url, opts) => {
    const res = await call(url, opts);
    if (res.status >= 400) {
      throw new Error(`${opts?.method || "GET"} ${url} → ${res.status} ${JSON.stringify(res.body)}`);
    }
    return res;
  };
  return { caller, must, close: () => new Promise((r) => server.close(r)) };
}

async function seed() {
  process.env.SALARY_ENCRYPTION_KEY = "0".repeat(64);
  process.env.JWT_SECRET = "ie-local-demo-only";

  const AccessDepartment = require("../../models/Access/AccessDepartment");
  const DeptUser = require("../../models/Access/DeptUser");
  const DepartmentRole = require("../../models/Access/DepartmentRole");
  const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
  const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
  const SalesJourney = require("../../models/CMS_Models/Sales/SalesJourney");
  const Enquiry = require("../../models/CMS_Models/Sales/Enquiry");
  const SampleStyle = require("../../models/CMS_Models/Sales/SampleStyle");
  const StockItem = require("../../models/CMS_Models/Inventory/Products/StockItem");
  const WorkOrder = require("../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");

  const company = await Acc_Company.create({
    companyName: "IE FEASIBILITY SHOWROOM · LOCAL ONLY",
    booksFromDate: new Date("2026-04-01"),
  });
  const department = await AccessDepartment.create({
    key: "ie", slug: "ie", name: "Industrial Engineering",
    dashboardPath: "/industrial-engineering", isActive: true,
  });

  /* Three seats, because the demonstration has to show what each one may do:
     an editor who assesses, an approver who is somebody ELSE (the maker-checker
     refuses a self-approval), and a viewer who may only read. */
  const people = {};
  for (const [key, email, role, name] of [
    ["editor", EDITOR, "editor", "Demo IE Engineer"],
    ["approver", APPROVER, "owner", "Demo IE Manager"],
    ["viewer", VIEWER, "viewer", "Demo IE Viewer"],
  ]) {
    const user = new DeptUser({ name, email, departmentId: department._id, isActive: true });
    await user.setPassword(PASSWORD);
    await user.save();
    await DepartmentRole.create({
      departmentSlug: "ie", departmentId: department._id, email, name, role, isActive: true,
    });
    await SpCompanyMembership.create({ companyId: company._id, email, personName: name });
    people[key] = {
      email, name, user,
      token: jwt.sign(
        { id: String(user._id), email, name, role: "ie", deptId: String(department._id), deptSlug: "ie" },
        process.env.JWT_SECRET, { expiresIn: "12h" },
      ),
    };
  }

  /* ── THE STYLE, WITH THE SALES PARENTS THAT PROVE ITS COMPANY ──────────── */
  const accountId = id();
  const journey = await SalesJourney.create({
    journeyId: "SJ-DEMO-POLO", companyId: company._id, accountId,
    ownerId: id(), ownerName: "Demo Sales", name: "Northwind Apparel · development", isActive: true,
  });
  const enquiry = await Enquiry.create({
    enquiryId: "ENQ-DEMO-POLO", journeyId: journey._id, accountId, companyId: company._id,
    title: "Piqué knit polo development", isActive: true,
    products: [{ product: "Polo", quantity: 500 }],
  });
  const item = await StockItem.create({
    name: PRODUCT_NAME, sku: "SKU-NW-POLO-26", reference: "REF-NW-POLO-26",
    category: "Garment", createdBy: id(),
    quantityOnHand: 0, minStock: 0, maxStock: 10,
    variants: [{ sku: "VAR-NW-POLO-26", cost: 0, salesPrice: 0 }],
  });
  const workOrder = await WorkOrder.create({
    workOrderNumber: "WO-NW-POLO-26", stockItemId: item._id, stockItemName: item.name,
    stockItemReference: item.reference, quantity: 500, originalQuantity: 500, status: "planned",
    timeline: { plannedStartDate: new Date("2026-10-05"), plannedEndDate: new Date("2026-10-28") },
    customerId: id(), customerName: "Northwind Apparel Ltd",
  });
  const style = await SampleStyle.create({
    sampleStyleId: "SS-NW-POLO-26", productName: PRODUCT_NAME, styleCode: STYLE_CODE,
    variantLabel: "Navy", variantKey: "navy",
    journeyId: journey._id, enquiryId: enquiry._id, sourceStockItemId: item._id,
    stage: "rnd", materials: { status: "pending", rawItems: [] },
    techSheet: {
      technical: { status: "approved", revision: TECHNICAL_REVISION },
      technicalRevisions: [{
        revision: TECHNICAL_REVISION,
        submittedAt: new Date("2026-08-01"), outcome: "approved", decidedAt: new Date("2026-08-05"),
        snapshot: { revision: TECHNICAL_REVISION, materials: [], requirements: [], operations: [] },
      }],
    },
    production: { workOrderIds: [workOrder._id] },
  });

  /* ── THE ENGINEERING FILE, BUILT THROUGH ITS OWN ROUTES ─────────────────
     Every step below is the route a person would use. Nothing is written into
     a collection directly, so the demonstration proves the chain works rather
     than describing a state the chain can never produce. */
  const { caller, must, close } = await ieRouter();
  try {
    const asEditor = must(caller(people.editor.token, company._id));
    const asApprover = must(caller(people.approver.token, company._id));

    const policy = (await asEditor("/allowance-policies", {
      method: "POST",
      body: { name: "Development allowance", effectiveFrom: "2026-01-01", categories: [] },
    })).body.policy;
    await asApprover(`/allowance-policies/${policy.policyId}/publish`, {
      method: "POST", body: { expectedRevision: 1 },
    });

    const file = (await asEditor(
      `/orders/${workOrder._id}/styles/${style._id}/engineering-file`,
      { method: "POST", body: {} },
    )).body.file;

    const OPERATIONS = [
      { code: "OP-COLLAR", name: "Attach rib collar", machineType: "SNLS", minutes: 1.6 },
      { code: "OP-PLACKET", name: "Set and edge-stitch placket", machineType: "SNLS", minutes: 1.4 },
      { code: "OP-SHOULDER", name: "Join shoulders with tape", machineType: "SNLS", minutes: 0.8 },
      { code: "OP-HEM", name: "Hem sleeve and bottom", machineType: "SNLS", minutes: 1.1 },
    ];
    const operations = [];
    for (const op of OPERATIONS) {
      operations.push((await asEditor("/operations/library", {
        method: "POST", body: { code: op.code, name: op.name, machineType: op.machineType },
      })).body.operation);
    }

    const bulletin = await asEditor(`/engineering-files/${file.fileId}/bulletin`, {
      method: "PATCH",
      body: {
        expectedRevision: 1,
        rows: operations.map((op) => ({ ieOperationId: op.operationId, proposedSamMinutes: 1 })),
      },
    });
    const rows = bulletin.body.file.bulletin.rows;

    /* A timed, approved method study per row — the evidence a bulletin needs
       before it may be submitted at all. */
    for (let i = 0; i < rows.length; i += 1) {
      const opened = await asEditor(
        `/engineering-files/${file.fileId}/bulletin/${rows[i].rowId}/method-studies`,
        { method: "POST", body: {} },
      );
      const studyId = opened.body.study.studyId;
      const filled = await asEditor(`/method-studies/${studyId}`, {
        method: "PATCH",
        body: {
          expectedRevision: 1, studiedAt: "2026-09-08T04:30:00.000Z", location: "Development line",
          methodNote: "Two-hand method, collar eased without tension.",
          ratingPercent: 100, observations: [{ durationSeconds: 60 }],
        },
      });
      const submitted = await asEditor(`/method-studies/${studyId}/submit`, {
        method: "POST",
        body: {
          expectedRevision: filled.body.study.revision,
          manualStandardTimeMinutes: OPERATIONS[i].minutes,
          overrideReason: "Standard agreed for the development run.",
        },
      });
      await asApprover(`/method-studies/${studyId}/approve`, {
        method: "POST", body: { expectedRevision: submitted.body.study.revision },
      });
    }

    /* ── AND THE ASSESSMENT, THROUGH ITS OWN ROUTE, IDEMPOTENTLY ─────────── */
    const outcome = await ensureDemoAssessment({
      call: caller(people.editor.token, company._id),
      fileId: file.fileId,
    });
    if (outcome.action === "refused") {
      throw new Error(`the demo assessment was refused: ${outcome.reason}`);
    }

    return {
      company: { id: String(company._id), name: company.companyName },
      style: { id: String(style._id), code: STYLE_CODE, name: PRODUCT_NAME },
      workOrderId: String(workOrder._id),
      fileId: file.fileId,
      assessment: {
        action: outcome.action,
        outcome: outcome.assessment.outcome,
        findings: outcome.assessment.findings.length,
        conditions: outcome.assessment.conditions.length,
        basedOnTechnicalRevision: outcome.assessment.basedOnTechnicalRevision,
      },
      people: Object.fromEntries(Object.entries(people).map(([k, v]) => [k, v.email])),
    };
  } finally {
    await close();
  }
}

async function main() {
  const mongo = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: "wiredTiger" },
  });
  const uri = mongo.getUri("ie_feasibility_demo");
  /* The one assertion worth making twice: this must be a local database. */
  if (!/^mongodb:\/\/(127\.0\.0\.1|localhost):/.test(uri)) {
    throw new Error("Demo MongoDB must bind to loopback");
  }
  process.env.MONGODB_URI = uri;
  await mongoose.connect(uri);

  let child;
  const stop = async () => {
    if (child && !child.killed) child.kill("SIGTERM");
    try { await mongoose.disconnect(); } catch { /* already down */ }
    await mongo.stop();
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  try {
    const outcome = await seed();
    await mongoose.disconnect();

    const source = process.env.IE_DEMO_BACKEND_DIR;
    if (!source || fs.existsSync(path.join(source, ".env")) || fs.existsSync(path.join(source, ".env.local"))) {
      throw new Error("IE_DEMO_BACKEND_DIR must name a clean source copy without environment files");
    }
    /* A real key for a project that does not exist: firebase-admin initialises,
       and every call it then makes fails to resolve instead of reaching a live
       project. */
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    const env = {
      PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "development",
      MONGODB_URI: uri, PORT: String(PORT), JWT_SECRET: "ie-local-demo-only",
      SALARY_ENCRYPTION_KEY: "0".repeat(64),
      FIREBASE_SERVICE_ACCOUNT: JSON.stringify({
        project_id: "grav-local-demo-invalid",
        client_email: "demo@grav-local-demo-invalid.iam.gserviceaccount.com",
        private_key: privateKey,
      }),
      FIREBASE_DATABASE_URL: "http://127.0.0.1:1",
      EXTRA_ALLOWED_ORIGINS: [
        `http://localhost:${FRONTEND_PORT}`,
        `http://127.0.0.1:${FRONTEND_PORT}`,
      ].join(","),
    };
    child = spawn(process.execPath, ["server.js"], { cwd: source, env, stdio: "inherit" });
    child.once("exit", (code) => {
      console.error(`IE demo backend exited (${code})`);
      void stop();
    });
    console.log(`IE FEASIBILITY DEMO READY: http://127.0.0.1:${PORT}`);
    console.log(`FRONTEND ORIGIN ALLOWED: http://localhost:${FRONTEND_PORT}`);
    console.log(`DEMO DATA: ${JSON.stringify(outcome)}`);
    console.log(`LOGIN (editor): ${EDITOR} / ${PASSWORD}`);
    console.log(`LOGIN (approver): ${APPROVER} / ${PASSWORD}`);
    console.log(`LOGIN (viewer): ${VIEWER} / ${PASSWORD}`);
    console.log("IN-MEMORY DATABASE ONLY; stopping this process discards all demo changes.");
  } catch (error) {
    console.error(error);
    try { await mongoose.disconnect(); } catch { /* already down */ }
    await mongo.stop();
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { DEMO_ASSESSMENT, STYLE_CODE, PRODUCT_NAME };

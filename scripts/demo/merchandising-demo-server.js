// Local-only Merchandising showroom. No configured MongoDB or Firebase credentials
// are passed to the child server. Closing this process discards the database.
"use strict";

const { generateKeyPairSync, randomUUID } = require("crypto");
const { spawn } = require("child_process");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

const PORT = 5199;
const DB = "merchandising_demo";
const EMAIL = "merch.demo@grav.local";
const PASSWORD = "DemoMerch2026!";
const id = () => new mongoose.Types.ObjectId();
const day = (offset) => {
  const value = new Date();
  value.setUTCHours(12, 0, 0, 0);
  value.setUTCDate(value.getUTCDate() + offset);
  return value.toISOString().slice(0, 10);
};

async function seed() {
  process.env.SALARY_ENCRYPTION_KEY = "0".repeat(64);
  const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
  const AccessDepartment = require("../../models/Access/AccessDepartment");
  const DeptUser = require("../../models/Access/DeptUser");
  const DepartmentRole = require("../../models/Access/DepartmentRole");
  const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
  const SalesHandoverVersion = require("../../models/CMS_Models/Sales/SalesHandoverVersion");
  const ExecutionFile = require("../../models/CMS_Models/Merchandising/ExecutionFile");
  const HandoverReceipt = require("../../models/CMS_Models/Merchandising/HandoverReceipt");
  const ExecutionUnit = require("../../models/CMS_Models/Merchandising/ExecutionUnit");
  const { SalesDevelopmentRequest } = require("../../models/CMS_Models/Sales/DevelopmentRequest");
  const { DevelopmentFile, DevelopmentRequestReceipt } = require("../../models/CMS_Models/Merchandising/Development");
  const { TnaPlan, TnaMilestone, TnaBaseline } = require("../../models/CMS_Models/Merchandising/TnaPlan");
  const { TnaTemplate, TnaTemplateVersion } = require("../../models/CMS_Models/Merchandising/TnaTemplate");
  const { WorkingCalendar, WorkingCalendarVersion } = require("../../models/CMS_Models/Merchandising/WorkingCalendar");

  const company = await Acc_Company.create({ companyName: "GRAV Demo Garments", booksFromDate: new Date("2026-04-01") });
  const department = await AccessDepartment.create({
    key: "merchandiser", slug: "merchandiser", name: "Merchandising",
    dashboardPath: "/merchandiser/dashboard", isActive: true,
  });
  const user = new DeptUser({ name: "Aisha Demo", email: EMAIL, passwordHash: "pending", departmentId: department._id });
  await user.setPassword(PASSWORD);
  await user.save();
  await DepartmentRole.create({ departmentSlug: "merchandiser", departmentId: department._id, email: EMAIL, name: user.name, role: "owner" });
  await SpCompanyMembership.create({ companyId: company._id, email: EMAIL, personName: user.name });
  const actor = { id: user._id, email: EMAIL, name: user.name };

  const styles = [
    ["Woven linen shirt", "LN-204", "Northstar Apparel", 750, -3],
    ["Cotton jersey polo", "PO-118", "Harbor & Co", 1200, 6],
    ["Utility overshirt", "OS-307", "Northstar Apparel", 640, 17],
    ["Relaxed twill trouser", "TR-092", "Fieldline", 980, 25],
    ["Ribbed knit cardigan", "KN-412", "Harbor & Co", 520, 33],
  ];
  const files = [];
  for (let i = 0; i < styles.length; i += 1) {
    const [productName, styleRef, buyerDisplayLabel, totalQuantity, dueOffset] = styles[i];
    const handoverRef = `DEMO-ORD-${String(i + 1).padStart(3, "0")}`;
    const handoverLineRef = `DEMO-LINE-${i + 1}`;
    const projection = {
      orderRef: handoverRef, orderLineRef: handoverLineRef,
      styleRef, productName, buyerDisplayLabel, totalQuantity,
      breakdown: [{ lineSplitRef: `SPLIT-${i + 1}`, attributes: [{ name: "Colour", value: i % 2 ? "Olive" : "Indigo" }], sizeRange: "XS–XXL", quantity: totalQuantity }],
      deliveries: [{ dropRef: `DROP-${i + 1}`, committedDeliveryDate: new Date(`${day(dueOffset)}T12:00:00Z`), quantity: totalQuantity, nominatedFactoryRef: i % 2 ? "Unit B" : "Unit A" }],
      packingRequirement: "Fold, polybag and carton by size",
      testingRequirement: "Buyer wash and colour-fastness tests",
      deliveryRequirement: "Ex-factory dispatch against confirmed drop",
    };
    const version = await SalesHandoverVersion.create({
      companyId: company._id, handoverRef, handoverLineRef, versionNo: 1,
      sourceRecord: { app: "sales", recordType: "customer_request", recordId: id(), sourceVersion: new Date().toISOString(), issuedAt: new Date() },
      executionProjection: projection, publication: { state: "CURRENT" }, issuedBy: actor,
    });
    if (i < 2) continue; // The first two stay in the real New Handovers inbox.
    const lifecycleStatus = i === 3 ? "ON_HOLD" : "OPEN";
    const file = await ExecutionFile.create({
      fileNumber: `MEF-2026-${String(i - 1).padStart(4, "0")}`,
      companyId: company._id, handoverRef, handoverLineRef,
      currentHandoverVersionId: version._id,
      sourceVersionHistory: [{ versionId: version._id, versionNo: 1, event: "ACCEPTED", at: new Date(), by: actor }],
      currentExecutionProjection: projection, lifecycleStatus,
      lifecycleReason: lifecycleStatus === "ON_HOLD" ? "Awaiting buyer-approved trim shade" : "",
      executionPhase: "INTAKE",
      responsibleMerchandiser: { email: EMAIL, name: user.name, assignedAt: new Date(), assignedBy: actor },
      coordinationNote: "Demo order for exploring the Merchandising workflow.", createdBy: actor,
    });
    await HandoverReceipt.create({
      companyId: company._id, handoverVersionId: version._id, handoverRef, handoverLineRef,
      sourceVersionNo: 1, state: "ACCEPTED", executionFileId: file._id,
      decidedBy: actor, decidedAt: new Date(), correlationId: randomUUID(),
    });
    await ExecutionUnit.create({
      companyId: company._id, fileId: file._id, unitDiscriminator: `UNIT:SPLIT-${i + 1}|DROP-${i + 1}`,
      lineSplitRef: `SPLIT-${i + 1}`, dropRef: `DROP-${i + 1}`,
      attributes: projection.breakdown[0].attributes, sizeRange: "XS–XXL",
      committedDeliveryDate: projection.deliveries[0].committedDeliveryDate,
      nominatedFactoryRef: projection.deliveries[0].nominatedFactoryRef,
      quantity: totalQuantity, sourceVersionId: version._id, sourceVersionNo: 1,
    });
    files.push(file);
  }

  const development = [
    ["Textured resort shirt", "RS-510", "Northstar Apparel", "NEW"],
    ["Performance running tee", "AT-224", "Harbor & Co", "ACTIVE"],
    ["Washed denim jacket", "DJ-630", "Fieldline", "AWAITING_APPROVAL"],
  ];
  for (let i = 0; i < development.length; i += 1) {
    const [productName, styleRef, buyerDisplayLabel, lifecycleStatus] = development[i];
    const journeyId = id();
    const productLineRef = `PL-DEMO-${i + 1}`;
    const request = await SalesDevelopmentRequest.create({
      companyId: company._id, requestRef: `DEMO-DEV-${i + 1}`, versionNo: 1,
      journeyId, journeyRef: `SJ-DEMO-${i + 1}`, enquiryId: id(), productLineRef,
      buyerDisplayLabel, productName, styleRef, requestedCategories: ["FABRIC", "TRIMS", "LABELS"],
      requirementSummary: "Choose fabric, trims and labels for the first sample.",
      requiredByDate: day(14 + i * 7), requestedBy: actor, requestedAt: new Date(),
    });
    const file = await DevelopmentFile.create({
      developmentNumber: `MDF-2026-${String(i + 1).padStart(4, "0")}`,
      companyId: company._id, journeyId, journeyRef: `SJ-DEMO-${i + 1}`,
      productLineRef, currentRequestId: request._id, currentRequestVersionNo: 1,
      requestHistory: [{ requestId: request._id, versionNo: 1, event: "ACCEPTED", at: new Date(), by: actor }],
      productName, styleRef, buyerDisplayLabel, requiredByDate: day(14 + i * 7),
      lifecycleStatus, responsibleMerchandiser: { email: EMAIL, name: user.name, assignedAt: new Date(), assignedBy: actor },
      createdBy: actor,
    });
    await DevelopmentRequestReceipt.create({
      companyId: company._id, requestRef: request.requestRef, requestVersionNo: 1,
      requestId: request._id, developmentFileId: file._id, state: "ACCEPTED",
      decidedBy: actor, decidedAt: new Date(),
    });
  }

  // Pin the plan to real published configuration, so the file-level tab can
  // show its calendar arithmetic instead of merely filling the portfolio.
  const calendar = await WorkingCalendar.create({
    companyId: company._id, calendarRef: "DEMO-WEEK", name: "Factory working week", createdBy: actor,
  });
  const calendarVersion = await WorkingCalendarVersion.create({
    companyId: company._id, calendarId: calendar._id, versionNo: 1, state: "PUBLISHED",
    effectiveFrom: day(-180), horizonTo: day(365), publishedBy: actor, publishedAt: new Date(),
    createdBy: actor,
  });
  const template = await TnaTemplate.create({
    companyId: company._id, templateRef: "DEMO-EXPORT", name: "Standard export order", createdBy: actor,
  });
  const steps = [
    ["FABRIC_APPROVED", "Fabric selection approved", "MERCHANDISING", "OVERDUE", -4],
    ["TRIM_CARD", "Trim card approved", "MERCHANDISING", "DUE_SOON", 2],
    ["PP_SAMPLE", "PP sample approved", "PRODUCT_DEVELOPMENT", "PENDING", 9],
    ["FABRIC_INHOUSE", "Fabric in-house", "STORE_SUPPLY_CHAIN", "PENDING", 16],
  ];
  const templateVersion = await TnaTemplateVersion.create({
    companyId: company._id, templateId: template._id, versionNo: 1, state: "PUBLISHED",
    effectiveFrom: day(-180), defaultCalendarId: calendar._id,
    milestones: steps.map(([milestoneCode, name, ownerDepartment], i) => ({
      milestoneCode, name, ownerDepartment,
      completionAuthority: ownerDepartment === "MERCHANDISING" ? "MERCHANDISING" : "SOURCE_EVENT",
      anchor: "PLAN_START", offsetWorkingDays: i * 5, scope: "FILE", sortOrder: i,
    })),
    dependencies: steps.slice(1).map(([milestoneCode], i) => ({
      dependencyRef: `DEP-${i + 1}`, predecessorCode: steps[i][0], successorCode: milestoneCode,
      type: "FINISH_TO_START", lagWorkingDays: 0,
    })),
    publishedBy: actor, publishedAt: new Date(), createdBy: actor,
  });
  const file = files[0];
  const plan = await TnaPlan.create({
    companyId: company._id, fileId: file._id,
    templateId: template._id, templateVersionId: templateVersion._id, templateVersionNo: 1, templateName: template.name,
    calendarId: calendar._id, calendarVersionId: calendarVersion._id, calendarVersionNo: 1, calendarName: calendar.name,
    state: "ACTIVE", planStartDate: day(-12), currentBaselineNo: 1,
    createdBy: actor,
  });
  await TnaBaseline.create({
    companyId: company._id, planId: plan._id, fileId: file._id, baselineNo: 1, state: "ACTIVE",
    templateVersionId: templateVersion._id, calendarVersionId: calendarVersion._id,
    planStartDate: day(-12), entries: steps.map(([milestoneCode, , , , offset]) => ({
      milestoneRef: milestoneCode, milestoneCode, baselineDate: day(offset - 1),
    })), approvedBy: actor, approvedAt: new Date(),
  });
  for (let i = 0; i < steps.length; i += 1) {
    const [milestoneCode, name, ownerDepartment, status, offset] = steps[i];
    await TnaMilestone.create({
      companyId: company._id, planId: plan._id, fileId: file._id,
      milestoneRef: milestoneCode, milestoneCode, name, ownerDepartment,
      completionAuthority: ownerDepartment === "MERCHANDISING" ? "MERCHANDISING" : "SOURCE_EVENT",
      scopeKind: "FILE", sequenceRank: i,
      baselineDate: day(offset - 1), forecastDate: day(offset), status,
    });
  }
  return { company: company.companyName, handovers: 2, executionFiles: files.length, developmentRequests: development.length, milestones: steps.length };
}

async function main() {
  const mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  const uri = mongo.getUri(DB);
  if (!/^mongodb:\/\/(127\.0\.0\.1|localhost):/.test(uri)) throw new Error("Demo database must bind to loopback");
  await mongoose.connect(uri);
  let child;
  const stop = async () => {
    if (child && !child.killed) child.kill("SIGTERM");
    await mongoose.disconnect();
    await mongo.stop();
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const counts = await seed();
  await mongoose.disconnect();
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  const backendDir = process.env.MERCH_DEMO_BACKEND_DIR;
  if (!backendDir || require("fs").existsSync(require("path").join(backendDir, ".env"))) {
    throw new Error("Set MERCH_DEMO_BACKEND_DIR to a clean source copy without .env");
  }
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "development",
    MONGODB_URI: uri, PORT: String(PORT), JWT_SECRET: "merchandising-local-demo-only",
    SALARY_ENCRYPTION_KEY: "0".repeat(64),
    FIREBASE_SERVICE_ACCOUNT: JSON.stringify({ project_id: "grav-local-demo-invalid", client_email: "demo@grav-local-demo-invalid.iam.gserviceaccount.com", private_key: privateKey }),
    FIREBASE_DATABASE_URL: "http://127.0.0.1:1",
  };
  child = spawn(process.execPath, ["server.js"], { cwd: backendDir, env, stdio: "inherit" });
  child.once("exit", (code) => { console.error(`Demo backend exited (${code})`); void stop(); });
  console.log(`MERCHANDISING DEMO READY: http://localhost:${PORT}`);
  console.log(`DEMO DATA: ${JSON.stringify(counts)}`);
  console.log(`LOGIN: ${EMAIL} / ${PASSWORD}`);
  console.log("LOCAL MEMORY DATABASE ONLY; stopping this process discards all demo changes.");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });

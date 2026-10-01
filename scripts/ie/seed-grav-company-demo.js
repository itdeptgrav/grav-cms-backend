#!/usr/bin/env node
"use strict";

/*
 * One-time, additive IE demonstration for the existing GRAV CLOTHING PVT LTD
 * company in the shared `test` database. Unlike seed-ie-demo.js, this script
 * must never create, replace, or delete the target company or grant access to
 * it. It writes a separate manifest so every newly created id is identifiable.
 *
 * Run only with IE_GRAV_DEMO_SEED=1 and --apply. There is intentionally no
 * automatic purge or force/rebuild mode: the company has other users' data.
 */

const mongoose = require("mongoose");
const { blankManifest, buildPrimary, PRIMARY_ORDERS } = require("./seed-ie-demo");
const { upsertCompanyWorld } = require("./ieDemoScenario");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const DeptUser = require("../../models/Access/DeptUser");
const Employee = require("../../models/Employee");

const MANIFEST = "ie_demo_manifest";
const MANIFEST_ID = "IE_DEMO_GRAV_V1";
const TARGET_ID = "6a08040a1fecacc9bb7149c2";
const TARGET_NAME = "GRAV CLOTHING PVT LTD";
const REF_PREFIX = "IE_DEMO_V1-grav-";

async function attribution(email) {
  const user = await DeptUser.findOne({ email, isActive: true });
  const employee = user?.employeeRef ? await Employee.findById(user.employeeRef) : null;
  if (!user || !employee) throw new Error(`Existing demo attribution identity missing: ${email}`);
  return { email, user, employee };
}

async function assertCleanTarget(db, companyId) {
  const manifest = await db.collection(MANIFEST).findOne({ _id: MANIFEST_ID });
  if (manifest) throw new Error(`${MANIFEST_ID} already exists; refusing a second run.`);

  const collisions = [
    ["salesjourneys", "journeyId"],
    ["enquiries", "enquiryId"],
    ["samplestyles", "sampleStyleId"],
    ["stockitems", "reference"],
    ["workorders", "workOrderNumber"],
  ];
  for (const [collection, field] of collisions) {
    const count = await db.collection(collection).countDocuments({ [field]: { $regex: `^${REF_PREFIX}` } });
    if (count) throw new Error(`Tagged records already exist in ${collection}; refusing a second run.`);
  }
  if (await db.collection("ie_operations").countDocuments({ companyId })) {
    throw new Error("The target company already has an IE operation library; refusing possible code collisions.");
  }
}

async function main() {
  if (process.env.IE_GRAV_DEMO_SEED !== "1" || !process.argv.includes("--apply")) {
    throw new Error("Explicit opt-in required: IE_GRAV_DEMO_SEED=1 and --apply.");
  }
  if (process.env.NODE_ENV === "production") throw new Error("Refusing NODE_ENV=production.");
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is required.");

  await mongoose.connect(process.env.MONGODB_URI, { autoIndex: false, serverSelectionTimeoutMS: 10000 });
  try {
    const db = mongoose.connection.db;
    if (db.databaseName !== "test") throw new Error("Refusing a database other than test.");
    const company = await Acc_Company.findById(TARGET_ID);
    if (!company || company.companyName !== TARGET_NAME) {
      throw new Error("The exact approved GRAV company was not found; refusing to create a replacement.");
    }
    await assertCleanTarget(db, company._id);

    const editor = await attribution("ie.editor.demo@grav.demo");
    const approver = await attribution("ie.approver.demo@grav.demo");
    const manifest = {
      ...blankManifest(),
      _id: MANIFEST_ID,
      tag: MANIFEST_ID,
      targetCompanyId: String(company._id),
      status: "INCOMPLETE",
      notes: ["Uses existing demo actors for audit attribution only; grants and company memberships are unchanged."],
    };
    try {
      const world = await upsertCompanyWorld("grav", TARGET_NAME, {
        orders: PRIMARY_ORDERS,
        manifest,
      });
      // The company pre-existed. Never record it among ids a future cleanup may delete.
      manifest.companyIds = [];
      await buildPrimary({
        ctx: { companyId: company._id, membershipSource: "SERVICE" },
        editor,
        approver,
        world,
        manifest,
        // A pending PPC handover in an existing company is not part of an IE
        // visual demo. The approved capacity standard is still created.
        skipRelease: true,
      });
      manifest.status = "COMPLETE";
      manifest.seededAt = new Date();
    } finally {
      manifest.companyIds = [];
      await db.collection(MANIFEST).replaceOne({ _id: MANIFEST_ID }, manifest, { upsert: true });
    }
    process.stdout.write(JSON.stringify({
      status: manifest.status,
      companyId: manifest.targetCompanyId,
      orders: manifest.workOrderIds.length,
      operations: manifest.operationIds.length,
      engineeringFiles: manifest.fileIds.length,
      approvedVersions: manifest.versionIds.length,
      lineLayouts: manifest.layoutIds.length,
      capacityStandards: manifest.standardIds.length,
      allowancePolicies: manifest.policyIds.length,
      rampProfiles: manifest.rampIds.length,
      releaseCount: manifest.releaseIds.length,
      leadOrderId: manifest.workOrderIds[0],
      leadFileId: manifest.fileIds[0],
    }) + "\n");
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`${error.name}: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { main, assertCleanTarget };

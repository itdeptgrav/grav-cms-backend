// scripts/seedCrmDemo.js
//
// The spec's demonstration data (Scenario A: buying house + brand linked;
// Scenario B: uniform client with sites + departments). DEV/DEMO ONLY — it
// refuses to run when NODE_ENV=production. Idempotent: keyed on externalReference
// so re-running updates rather than duplicating.
//
//   node -r dotenv/config scripts/seedCrmDemo.js
//
"use strict";

const mongoose = require("mongoose");
const Account = require("../models/CMS_Models/Sales/Account");
const Contact = require("../models/CMS_Models/Sales/Contact");
const Site = require("../models/CMS_Models/Sales/Site");
const Department = require("../models/CMS_Models/Sales/Department");
const Relationship = require("../models/CMS_Models/Sales/AccountRelationship");
const Activity = require("../models/CMS_Models/Sales/Activity");

async function upsertAccount(data) {
  const existing = await Account.findOne({ sourceSystem: "DEMO", externalReference: data.externalReference });
  if (existing) {
    Object.assign(existing, data);
    await existing.save();
    return existing;
  }
  return Account.create({ ...data, sourceSystem: "DEMO" });
}

async function seedCrmDemo() {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Refusing to seed demo data with NODE_ENV=production.");
  }
  const uri = process.env.MONGODB_URI || "mongodb://localhost:27017/grav_clothing";
  const alreadyConnected = mongoose.connection.readyState === 1;
  if (!alreadyConnected) await mongoose.connect(uri);

  // ── Scenario A: buying house + brand ──────────────────────────────────────
  const northstar = await upsertAccount({
    companyName: "Northstar Buying Services",
    roles: ["buying_house"],
    lifecycleStage: "prospect",
    externalReference: "DEMO-NORTHSTAR",
  });
  const harbor = await upsertAccount({
    companyName: "Harbor & Field",
    roles: ["direct_brand"],
    lifecycleStage: "development",
    externalReference: "DEMO-HARBOR",
  });

  // Link Northstar as Buying House For Harbor & Field (skip if it exists).
  const relExists = await Relationship.findOne({
    fromAccountId: northstar._id,
    toAccountId: harbor._id,
    relationshipType: "buying_house_for",
    isActive: true,
  });
  if (!relExists) {
    await Relationship.create({
      fromAccountId: northstar._id,
      toAccountId: harbor._id,
      relationshipType: "buying_house_for",
    });
  }

  await Contact.findOneAndUpdate(
    { accountId: northstar._id, email: "merch@northstar.demo" },
    { firstName: "Nadia", lastName: "Rao", roles: ["merchandiser", "buyer"], email: "merch@northstar.demo", accountId: northstar._id },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  await Contact.findOneAndUpdate(
    { accountId: harbor._id, email: "tech@harborfield.demo" },
    { firstName: "Theo", lastName: "Vance", roles: ["approver", "technical_quality"], email: "tech@harborfield.demo", accountId: harbor._id },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  // ── Scenario B: uniform client with sites + departments ───────────────────
  const metro = await upsertAccount({
    companyName: "MetroCare Hospitals",
    roles: ["uniform_client", "hospital_healthcare"],
    lifecycleStage: "prospect",
    externalReference: "DEMO-METROCARE",
  });

  const siteSpecs = [
    { name: "MetroCare Head Office", siteType: "head_office", siteCode: "HO", isPrimary: true },
    { name: "MetroCare Central Hospital", siteType: "hospital", siteCode: "H1" },
    { name: "MetroCare West Hospital", siteType: "hospital", siteCode: "H2" },
  ];
  for (const s of siteSpecs) {
    await Site.findOneAndUpdate(
      { accountId: metro._id, siteCode: s.siteCode },
      { ...s, accountId: metro._id },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
  }
  for (const name of ["Procurement", "HR/Admin", "Accounts", "Housekeeping"]) {
    await Department.findOneAndUpdate(
      { accountId: metro._id, name },
      { name, accountId: metro._id },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
  }
  await Contact.findOneAndUpdate(
    { accountId: metro._id, email: "contracts@metrocare.demo" },
    { firstName: "Meera", lastName: "Kulkarni", roles: ["contract_owner", "uniform_coordinator"], email: "contracts@metrocare.demo", accountId: metro._id },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  // A logged site visit + a follow-up task, so the timeline isn't empty.
  const visitExists = await Activity.findOne({ accountId: metro._id, subject: "Discovery site visit — MetroCare Central" });
  if (!visitExists) {
    await Activity.create({ accountId: metro._id, activityType: "site_visit", subject: "Discovery site visit — MetroCare Central", status: "completed", completedAt: new Date() });
    await Activity.create({ accountId: metro._id, activityType: "task", subject: "Collect uniform requirements by department", status: "planned", dueDate: new Date(Date.now() + 5 * 864e5) });
  }

  console.log("[seedCrmDemo] Seeded Scenario A (Northstar↔Harbor) and Scenario B (MetroCare + sites/departments).");
  if (!alreadyConnected) await mongoose.disconnect();
}

if (require.main === module) {
  seedCrmDemo()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[seedCrmDemo] failed:", err);
      process.exit(1);
    });
}

module.exports = seedCrmDemo;

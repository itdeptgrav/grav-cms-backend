// scripts/importCustomersToPipeline.js
//
// Put every existing Customer onto the Sales pipeline (one Journey each, on
// its Account), once. The same function the Sales settings page's button runs
// (services/sales/customerPipelineImport.js), for a deploy where nobody is
// there to click it. Idempotent: a customer already on the board is skipped.
//
//   node scripts/importCustomersToPipeline.js            # writes
//   node scripts/importCustomersToPipeline.js --dry-run  # lists only
//
// Run from grav-backend/ so .env is read. Needs exactly one company in
// acc_companies (the sole-company deployment) — otherwise say which with
// COMPANY_ID=<id>. A journey a customer's own salesperson does not own goes to
// OWNER_EMAIL=<e-mail of a CMS login: an Employee, a Sales or CEO department
// user>, else the CEO user — the same owner the settings button gives when the
// CEO clicks it. (Journey owners are CMS login ids: Sales people are
// `employees` rows; `salesdepartments` is empty on this deployment.)
"use strict";

require("dotenv").config();
const mongoose = require("mongoose");
require("dns").setServers(["8.8.8.8", "8.8.4.4"]);

(async () => {
  const dryRun = process.argv.includes("--dry-run");
  await mongoose.connect(process.env.MONGODB_URI);
  try {
    const { Acc_Company } = require("../models/Accountant_model/Acc_MasterModels");
    let companyId = process.env.COMPANY_ID || "";
    if (!companyId) {
      const companies = await Acc_Company.find({}).select("_id companyName isPrimary").limit(5).lean();
      const pick = companies.find((c) => c.isPrimary) || (companies.length === 1 ? companies[0] : null);
      if (!pick) throw new Error(`Expected one (or a primary) company, found ${companies.length}. Set COMPANY_ID=<id>.`);
      companyId = String(pick._id);
      console.log(`Company: ${pick.companyName || companyId}`);
    }
    const Employee = require("../models/Employee");
    const SalesDepartment = require("../models/SalesDepartment");
    const CEODepartment = require("../models/CEODepartment");
    let ownerDoc = null;
    if (process.env.OWNER_EMAIL) {
      const email = String(process.env.OWNER_EMAIL).trim().toLowerCase();
      for (const M of [Employee, SalesDepartment, CEODepartment]) {
        ownerDoc = await M.findOne({ email }).select("_id name email").lean();
        if (ownerDoc) break;
      }
      if (!ownerDoc) throw new Error(`No CMS login with the e-mail ${email} (looked in employees, sales and CEO users).`);
    } else {
      ownerDoc = await CEODepartment.findOne({ isActive: { $ne: false } }).select("_id name email").sort({ createdAt: 1 }).lean();
      if (!ownerDoc) throw new Error("No CEO user to own the journeys. Set OWNER_EMAIL=<e-mail of a CMS login>.");
    }
    const fallbackOwner = { id: ownerDoc._id, name: ownerDoc.name || ownerDoc.email };
    console.log(`Fallback owner: ${fallbackOwner.name}`);

    const scope = {
      companyId: new mongoose.Types.ObjectId(companyId),
      membershipSource: "PRIMARY_COMPANY_LEGACY",
      allowUnowned: true,
      clause: { $or: [{ companyId: new mongoose.Types.ObjectId(companyId) }, { companyId: null }, { companyId: { $exists: false } }] },
    };
    const ownership = { companyId: scope.companyId, companyOwnership: { source: "PRIMARY_COMPANY_LEGACY", resolvedAt: new Date(), proven: false } };

    const { importCustomersIntoPipeline } = require("../services/sales/customerPipelineImport");
    const r = await importCustomersIntoPipeline({ scope, ownership, actor: fallbackOwner, fallbackOwner, dryRun });
    console.log(`${dryRun ? "[dry run] " : ""}${r.customers} customers: ${r.created.length} ${dryRun ? "would be " : ""}placed on the pipeline, ${r.alreadyThere.length} already there, ${r.skippedTest.length} test accounts skipped, ${r.failed.length} failed.`);
    for (const x of r.created) console.log(`  + ${x.customerId || "—"}  ${x.company}  (account ${x.accountId}, ${x.accountEstablishedBy})${x.journeyId ? `  → ${x.journeyId}` : ""}`);
    for (const x of r.alreadyThere) console.log(`  = ${x.customerId || "—"}  ${x.company}  → ${x.journeyId}`);
    for (const x of r.failed) console.log(`  ! ${x.customerId || "—"}  ${x.name}: ${x.reason}`);
    process.exitCode = r.failed.length ? 1 : 0;
  } finally {
    await mongoose.disconnect();
  }
})().catch((err) => { console.error(err); process.exit(1); });

// scripts/importCustomersToPipeline.js
//
// Put every existing Customer onto the Sales pipeline (a Lead each), once.
// The same function the Sales settings page's button runs
// (services/sales/customerPipelineImport.js), for a deploy where nobody is
// there to click it. Idempotent: a customer already on the board is skipped.
//
//   node scripts/importCustomersToPipeline.js            # writes
//   node scripts/importCustomersToPipeline.js --dry-run  # lists only
//
// Run from grav-backend/ so .env is read. Needs exactly one company in
// acc_companies (the sole-company deployment) — otherwise say which with
// COMPANY_ID=<id>.
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
      const companies = await Acc_Company.find({}).select("_id name").limit(2).lean();
      if (companies.length !== 1) throw new Error(`Expected one company, found ${companies.length}. Set COMPANY_ID=<id>.`);
      companyId = String(companies[0]._id);
      console.log(`Company: ${companies[0].name || companyId}`);
    }
    const ownership = { companyId, companyOwnership: { source: "PRIMARY_COMPANY_LEGACY", resolvedAt: new Date(), proven: false } };
    const { importCustomersIntoPipeline } = require("../services/sales/customerPipelineImport");
    const r = await importCustomersIntoPipeline({ ownership, actor: null, dryRun });
    console.log(`${dryRun ? "[dry run] " : ""}${r.customers} customers: ${r.created.length} ${dryRun ? "would be " : ""}placed on the pipeline, ${r.alreadyThere.length} already there, ${r.failed.length} failed.`);
    for (const x of r.created) console.log(`  + ${x.customerId || "—"}  ${x.company}${x.leadRef ? `  → ${x.leadRef}` : ""}`);
    for (const x of r.failed) console.log(`  ! ${x.customerId || "—"}  ${x.name}: ${x.reason}`);
    process.exitCode = r.failed.length ? 1 : 0;
  } finally {
    await mongoose.disconnect();
  }
})().catch((err) => { console.error(err); process.exit(1); });

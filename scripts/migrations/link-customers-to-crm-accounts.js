// scripts/migrations/link-customers-to-crm-accounts.js
//
// EVERY EXISTING PORTAL CUSTOMER GETS ITS PLACE ON THE SALES PIPELINE.
//
// The pipeline (Sales journeys) starts from a CRM Account; a portal Customer
// with no Account cannot be picked, so a salesperson had to register them
// again as a prospect. The owner (7 Oct 2026): existing customers must simply
// be there — "no need to create the prospects".
//
// For each live Customer this:
//   1. establishes their Account through the ONE service that knows how
//      (`services/sales/customerAccountLink.ensure`): an account already
//      linked wins; one proved by the customer's own order is repaired;
//      otherwise one is created and linked, under the primary company;
//   2. marks the account a CUSTOMER (`type: "customer"`,
//      `lifecycleStage: "customer"`), never a prospect — they already buy;
//   3. carries the customer's e-mail, phone and GST number onto a created
//      account, so the record is not a bare name.
//
// Skipped, and said so: inactive customers, and the "CAD TEST ORG" records
// whose own name says not to use them. Nothing is deleted or renamed, no
// existing account's name or terms are touched, and an AMBIGUOUS or ARCHIVED
// answer from the service is reported for a person to resolve.
//
// Dry run by default. `--apply` writes.
//
//   node -r dotenv/config scripts/migrations/link-customers-to-crm-accounts.js
//   node -r dotenv/config scripts/migrations/link-customers-to-crm-accounts.js --apply
"use strict";

require("dns").setServers(["8.8.8.8", "8.8.4.4"]);
const mongoose = require("mongoose");

const APPLY = process.argv.includes("--apply");

const Customer = require("../../models/Customer_Models/Customer");
const Account = require("../../models/CMS_Models/Sales/Account");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const customerAccountLink = require("../../services/sales/customerAccountLink.service");

/* The CEO as the actor on record. The same person the pipeline names on every
   account it creates today. */
const ACTOR = { id: "69f057f6c02292fc8d7f48f2", name: "Chief Executive Officer" };

const SKIP_NAME = /^CAD TEST ORG/i;

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);

  /* ── THE COMPANY, AND A SCOPE SHAPED EXACTLY AS salesScope BUILDS IT ──
     Primary company, and — because this deployment holds one company — the
     clause admits unowned rows too, as `scopeFor` does. Mirrored here rather
     than imported because `scopeFor` needs a request. */
  const companies = await Acc_Company.find({}).select("_id name isPrimary").lean();
  const primary = companies.find((c) => c.isPrimary) || (companies.length === 1 ? companies[0] : null);
  if (!primary) throw new Error(`Cannot pick the company: ${companies.length} companies, none primary.`);
  const allowUnowned = companies.length === 1;
  const scope = {
    companyId: primary._id,
    membershipSource: "CANONICAL_GRAV_ORGANISATION",
    clause: {
      $or: [
        { companyId: primary._id },
        ...(allowUnowned ? [{ companyId: null }, { companyId: { $exists: false } }] : []),
      ],
    },
  };
  console.log(`${APPLY ? "APPLY" : "DRY RUN"} — company ${primary.name || primary._id}`);

  const customers = await Customer.find({})
    .select("name email phone gstNumber isActive profile businessInfo")
    .sort({ createdAt: 1 })
    .lean();

  const tally = { linked: 0, repaired: 0, created: 0, skipped: 0, problem: 0, marked: 0 };
  for (const c of customers) {
    const label = `${c.name} <${c.email}>`;
    if (c.isActive === false) { tally.skipped += 1; console.log(`  SKIP   ${label} — inactive`); continue; }
    if (SKIP_NAME.test(c.name || "")) { tally.skipped += 1; console.log(`  SKIP   ${label} — test record`); continue; }

    const out = await customerAccountLink.ensure({
      scope, customerId: c._id, customer: c, actor: ACTOR, dryRun: !APPLY,
    });
    if (!out.ok) {
      tally.problem += 1;
      console.log(`  ??     ${label} — ${out.code}: ${out.message}`);
      continue;
    }

    const how = out.establishedBy;
    tally[how === "LINKED" ? "linked" : how === "REPAIRED" ? "repaired" : "created"] += 1;
    const accountName = out.account?.companyName || out.name || "(new)";
    console.log(`  ${how.padEnd(8)} ${label} → ${accountName}${out.account?.accountId ? ` (${out.account.accountId})` : ""}`);
    if (!APPLY) continue;

    /* ── A CUSTOMER, NOT A PROSPECT ─────────────────────────────────────
       Set on every account reached here, created or found: the person behind
       it holds a portal login and has bought. Contact details only where the
       account has none — an existing account's own entries stand. */
    const set = { type: "customer", lifecycleStage: "customer" };
    const unset = {};
    const acc = await Account.findById(out.account._id).select("primaryEmail primaryPhone gstNumber type lifecycleStage").lean();
    if (acc) {
      if (!acc.primaryEmail && c.email) set.primaryEmail = String(c.email).trim().toLowerCase();
      if (!acc.primaryPhone && c.phone) set.primaryPhone = String(c.phone).trim();
      if (!acc.gstNumber && (c.gstNumber || c.profile?.gstNumber)) set.gstNumber = String(c.gstNumber || c.profile.gstNumber).trim().toUpperCase();
      const r = await Account.updateOne({ _id: out.account._id }, { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}) });
      if (r.modifiedCount) tally.marked += 1;
    }
  }

  console.log(`\n${APPLY ? "Done" : "Would do"}: already linked ${tally.linked}, repaired ${tally.repaired}, created ${tally.created}, `
    + `marked as customer ${tally.marked}, skipped ${tally.skipped}, need a person ${tally.problem}.`);
  if (!APPLY) console.log("Nothing was written. Re-run with --apply.");
  await mongoose.disconnect();
}

main().catch((err) => { console.error(err); process.exit(1); });

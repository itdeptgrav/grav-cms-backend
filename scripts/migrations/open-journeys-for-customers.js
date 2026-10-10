// scripts/migrations/open-journeys-for-customers.js
//
// EVERY EXISTING CUSTOMER ON THE SALES PIPELINE (7 Oct 2026, owner).
//
// The Pipeline page lists Sales JOURNEYS. A customer with an account but no
// journey has nothing on it, so the owner asked for every existing customer —
// all of them, test records included — to appear there without anybody
// registering a prospect first.
//
// For each portal Customer this:
//   1. makes sure a CRM Account exists for them (the same service the
//      customer→account script used, so no second link is ever invented);
//   2. opens ONE journey on that account if it has none, named after the
//      customer, through the same route handler the pipeline's own "Start
//      journey" uses — so the enquiry, the audit entry and the stamps are
//      exactly what a hand-started journey gets.
//
// An account that already has a journey is left alone. Nothing is deleted.
// Dry run by default; `--apply` writes.
//
//   node -r dotenv/config scripts/migrations/open-journeys-for-customers.js
//   node -r dotenv/config scripts/migrations/open-journeys-for-customers.js --apply
"use strict";

require("dns").setServers(["8.8.8.8", "8.8.4.4"]);
const mongoose = require("mongoose");

const APPLY = process.argv.includes("--apply");

const Customer = require("../../models/Customer_Models/Customer");
const Account = require("../../models/CMS_Models/Sales/Account");
const SalesJourney = require("../../models/CMS_Models/Sales/SalesJourney");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const customerAccountLink = require("../../services/sales/customerAccountLink.service");

const ACTOR = { id: "69f057f6c02292fc8d7f48f2", name: "Chief Executive Officer", email: "ceo@grav.in" };

/* The journey create route, driven in-process with a request shaped like the
   browser's, so every rule it applies (account usable, ownership stamp,
   enquiry opened, audit entry) applies here. */
async function createJourneyThroughRoute({ accountId, name }) {
  const router = require("../../routes/CMS_Routes/Sales/salesJourneys");
  const layer = router.stack.find((l) => l.route && l.route.path === "/" && l.route.methods.post);
  if (!layer) throw new Error("The journey create route was not found.");
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  const req = {
    method: "POST", body: { accountId: String(accountId), name },
    user: { id: ACTOR.id, name: ACTOR.name, email: ACTOR.email, role: "ceo", userType: "ceo", deptSlug: "sales" },
    headers: {}, query: {}, params: {},
    get: () => undefined,
  };
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(body) { (this.statusCode >= 400 ? reject : resolve)(Object.assign(new Error(body?.message || `HTTP ${this.statusCode}`), { body })); return this; },
      set() { return this; },
    };
    handler(req, res).catch(reject);
  }).then((out) => out.body);
}

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const companies = await Acc_Company.find({}).select("_id name isPrimary").lean();
  const primary = companies.find((c) => c.isPrimary) || (companies.length === 1 ? companies[0] : null);
  if (!primary) throw new Error(`Cannot pick the company: ${companies.length} companies, none primary.`);
  const scope = {
    companyId: primary._id, membershipSource: "CANONICAL_GRAV_ORGANISATION",
    clause: { $or: [{ companyId: primary._id }, ...(companies.length === 1 ? [{ companyId: null }, { companyId: { $exists: false } }] : [])] },
  };
  console.log(`${APPLY ? "APPLY" : "DRY RUN"} — company ${primary.name || primary._id}`);

  const customers = await Customer.find({}).select("name email profile businessInfo isActive").sort({ createdAt: 1 }).lean();
  const tally = { journeyExists: 0, opened: 0, accountCreated: 0, problem: 0 };

  for (const c of customers) {
    const label = `${c.name} <${c.email}>`;
    const link = await customerAccountLink.ensure({ scope, customerId: c._id, customer: c, actor: ACTOR, dryRun: !APPLY });
    if (!link.ok) { tally.problem += 1; console.log(`  ??      ${label} — ${link.code}: ${link.message}`); continue; }
    if (link.created) tally.accountCreated += 1;
    if (!APPLY && !link.account) { tally.opened += 1; console.log(`  OPEN    ${label} → (account to be created) → journey "${c.name}"`); continue; }

    const accountId = link.account._id;
    const existing = await SalesJourney.findOne({ accountId }).select("journeyId name").lean();
    if (existing) { tally.journeyExists += 1; console.log(`  HAS     ${label} → ${existing.journeyId} "${existing.name}"`); continue; }

    if (!APPLY) { tally.opened += 1; console.log(`  OPEN    ${label} → journey "${c.name}"`); continue; }
    /* A customer's account is a customer, not a prospect, whatever opened it. */
    await Account.updateOne({ _id: accountId }, { $set: { type: "customer", lifecycleStage: "customer", status: "active", isActive: true } });
    try {
      const out = await createJourneyThroughRoute({ accountId, name: c.name });
      tally.opened += 1;
      console.log(`  OPENED  ${label} → ${out?.journey?.reference || "?"} "${out?.journey?.name || c.name}"`);
    } catch (err) {
      tally.problem += 1;
      console.log(`  ??      ${label} — ${err.message}`);
    }
  }

  console.log(`\n${APPLY ? "Done" : "Would do"}: journeys opened ${tally.opened}, already on the pipeline ${tally.journeyExists}, `
    + `accounts created on the way ${tally.accountCreated}, need a person ${tally.problem}.`);
  if (!APPLY) console.log("Nothing was written. Re-run with --apply.");
  await mongoose.disconnect();
}

main().catch((err) => { console.error(err); process.exit(1); });

// scripts/repair/customer-account-links.js
//
// THE CUSTOMERS ALREADY IN THE BROKEN STATE.
//
// `POST /api/cms/sales/customers` created a portal customer and nothing else,
// so every customer Sales created that way has no commercial record and their
// payment terms had nowhere to live. The creation path is fixed; this is for
// the ones created before it was.
//
//   node scripts/repair/customer-account-links.js --company <id>
//   node scripts/repair/customer-account-links.js --company <id> --apply
//
// ── DRY RUN UNLESS TOLD OTHERWISE ──────────────────────────────────────────
// It reports what it WOULD do and writes nothing. `--apply` is the only way
// anything is written, and even then it writes through the same service the
// screen uses — one claim per customer, one account, idempotent, and refusing
// wherever a person has to decide.
//
// ── WHAT IT WILL NOT DO ────────────────────────────────────────────────────
//   · match anything by name — not the company name, not the trading name,
//     not "close enough". A name is evidence of nothing here, and four of
//     five correct links on live data would fail a similarity test;
//   · create a second account for a customer that has one;
//   · touch a customer whose records conflict. Two accounts claiming one
//     customer is a real mistake somebody made, and picking a winner in a
//     script is how the wrong buyer's terms end up on an invoice. Those are
//     listed for a person;
//   · merge two customers. Ever.
"use strict";

require("dotenv").config();
const mongoose = require("mongoose");

const Customer = require("../../models/Customer_Models/Customer");
const customerAccountLink = require("../../services/sales/customerAccountLink.service");

const arg = (name, fallback = null) => {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? (process.argv[at + 1] || true) : fallback;
};
const has = (name) => process.argv.includes(`--${name}`);

async function main() {
  const companyId = arg("company");
  const apply = has("apply");
  const limit = Number(arg("limit", 500));

  if (!companyId || companyId === true) {
    console.error("Which company? --company <id>\\n"
      + "A commercial record belongs to one company, and a repair that guessed which "
      + "would put a customer in the wrong one.");
    process.exit(2);
  }

  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);
  /* The same scope shape the routes build, so this script can reach nothing a
     signed-in salesperson of that company could not. */
  const scope = {
    companyId: new mongoose.Types.ObjectId(String(companyId)),
    clause: { $or: [{ companyId: new mongoose.Types.ObjectId(String(companyId)) }] },
  };

  const customers = await Customer.find({ createdBySales: true, isActive: true })
    .select("_id customerId name email profile.companyName businessInfo.companyName")
    .limit(limit)
    .lean();

  const report = { checked: 0, alreadyLinked: 0, repairable: 0, wouldCreate: 0, conflicts: [], done: [] };

  for (const customer of customers) {
    report.checked += 1;
    /* eslint-disable no-await-in-loop */
    const found = await customerAccountLink.resolve({ scope, customerId: customer._id });

    if (found.state === customerAccountLink.STATE.LINKED) { report.alreadyLinked += 1; continue; }
    if (found.state === customerAccountLink.STATE.AMBIGUOUS || found.state === customerAccountLink.STATE.ARCHIVED) {
      report.conflicts.push({
        customer: customer.customerId || String(customer._id),
        name: customer.name,
        state: found.state,
        reason: found.reason,
        candidates: found.candidates || (found.archived ? [found.archived] : []),
      });
      continue;
    }
    if (found.state === customerAccountLink.STATE.REPAIRABLE) report.repairable += 1;
    else report.wouldCreate += 1;

    if (!apply) continue;
    const result = await customerAccountLink.ensure({
      scope, customerId: customer._id, customer, actor: { name: "Repair script" },
    });
    if (!result.ok) {
      report.conflicts.push({
        customer: customer.customerId || String(customer._id),
        name: customer.name,
        state: result.code,
        reason: result.message,
      });
      continue;
    }
    report.done.push({
      customer: customer.customerId || String(customer._id),
      name: customer.name,
      account: result.account?.accountId || String(result.account?._id || ""),
      establishedBy: result.establishedBy,
    });
  }

  console.log(JSON.stringify({ mode: apply ? "APPLIED" : "DRY RUN", ...report }, null, 2));
  if (!apply && (report.repairable || report.wouldCreate)) {
    console.log("\\nNothing was written. Re-run with --apply to establish these.");
  }
  if (report.conflicts.length) {
    console.log(`\\n${report.conflicts.length} customer(s) need a person: two records claim them, or their `
      + "record was archived. Nothing was changed for those.");
  }
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});

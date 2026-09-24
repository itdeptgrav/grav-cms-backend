// models/CMS_Models/Sales/CustomerAccountClaim.js
//
// ONE CUSTOMER, ONE ACCOUNT — ENFORCED BY THE DATABASE, NOT BY HOPE.
//
// Setting up a customer's payment terms creates the sales account behind the
// screen. Two clicks half a second apart are two requests, and both would
// find no account and both would create one — leaving a customer with two
// accounts, two sets of terms, and a screen that can no longer say which is
// theirs.
//
// ── WHY A CLAIM AND NOT A UNIQUE INDEX ─────────────────────────────────────
// `Account.linkedCustomer` could carry a unique partial index, and on an
// empty database that would be the obvious answer. On this one it is a build
// against a live collection that already holds duplicates — the same portal
// customer is linked from two accounts today, a real mistake somebody made —
// so the build would fail, and forcing it through would mean deciding which
// of two real accounts to break.
//
// `_id` needs no index built: MongoDB has always enforced it. So the claim IS
// the customer's id, an insert is the atomic act, and the loser of the race
// reads the winner's answer instead of creating a second account. No
// migration, no index build, no ambiguity.
//
// The claim RECORDS a decision; it does not replace it. `Account.linkedCustomer`
// is still the link every reader uses.
"use strict";

const mongoose = require("mongoose");

const customerAccountClaimSchema = new mongoose.Schema(
  {
    /* ── `<company>:<customer>` ─────────────────────────────────────────
       The uniqueness this collection exists for, and it is PER COMPANY.

       The same portal login can buy from two of this group's companies, and
       each keeps its own commercial record of them — one company's terms are
       not the other's to read, let alone to reuse. Keying the claim on the
       customer alone would have made the second company's setup collide with
       the first's and hand it a record it cannot see. */
    _id: { type: String, required: true },
    customerId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    accountId: { type: mongoose.Schema.Types.ObjectId, ref: "CRMAccount", required: true },
    /* Which company's account it is, so a claim can never be read across a
       tenancy boundary by mistake. */
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    /* How the relationship was established: `CREATED` — set up here; `LINKED`
       — an existing account was already pointing at this customer; `REPAIRED`
       — proved from the order the customer actually placed. Never `MATCHED`,
       because nothing here matches anything by name. */
    establishedBy: { type: String, enum: ["CREATED", "LINKED", "REPAIRED"], required: true },
    establishedAt: { type: Date, default: Date.now },
    establishedByUser: {
      id: { type: mongoose.Schema.Types.ObjectId },
      name: { type: String, trim: true },
    },
  },
  { collection: "customer_account_claims", versionKey: false },
);

module.exports = mongoose.models.CustomerAccountClaim
  || mongoose.model("CustomerAccountClaim", customerAccountClaimSchema);

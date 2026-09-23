"use strict";
/**
 * services/centralCosting/shippingDestination.service.js
 *
 * WHERE THE FINISHED ORDER IS DELIVERED — RESOLVED ONCE, FOR EVERY CALLER.
 *
 * ── THE LEAK THIS CLOSES ────────────────────────────────────────────────────
 * The freight register loaded a specific destination with
 * `CRMAddress.findOne({ _id, isActive: true })` — no company anywhere in the
 * query. A `CRMAddress` carries no company of its own; it belongs to an
 * Account, and the Account is what carries ownership. So that query would
 * happily resolve, snapshot and freeze another company's customer address into
 * this company's freight quotation: their customer's name, their delivery
 * instructions, their city, readable from a register they cannot see.
 *
 * ── AND WHY THE ACCOUNT IS IN THE SAME QUERY ────────────────────────────────
 * Not "find the address, then check its account". That is a global read
 * followed by an application-side filter, and every one of those is a decision
 * about whether to disclose taken AFTER the data is already in hand. The
 * account clause is part of the selector: a foreign address is not found, in
 * exactly the way a nonexistent one is not found.
 *
 * ── AND SHIPPING IS NOT BILLING ─────────────────────────────────────────────
 * `CRMAddress.addressType` exists because these differ. A billing address is
 * where the invoice goes; delivering garments to the accounts department is a
 * real and expensive mistake, and one nobody would notice until the lorry
 * arrived. So the type is REQUIRED, never converted and never fallen back to.
 */

const mongoose = require("mongoose");

const CRMAddress = require("../../models/CMS_Models/Sales/Address");
const Account = require("../../models/CMS_Models/Sales/Account");
const { soleCompanyDeployment } = require("../companyContext/salesScope.service");

const REASON = Object.freeze({
  /* One answer for missing, foreign, inactive and unowned. Saying which would
     confirm a record the caller cannot see. */
  NOT_FOUND: "SHIPPING_ADDRESS_NOT_FOUND",
  /* Told apart ONLY for an address this company demonstrably owns: there the
     caller may already see it, and "that one is the billing address" is the
     difference between a five-second fix and a mystery. */
  NOT_SHIPPING: "SHIPPING_ADDRESS_WRONG_TYPE",
});

const oid = (v) => (mongoose.Types.ObjectId.isValid(String(v || "")) ? String(v) : "");

/**
 * The company clause for Sales-owned records, matching `salesScope`'s policy.
 *
 * Legacy records carry `companyId: null`. They are usable only where ownership
 * cannot be ambiguous — a proven single-company deployment — and are refused
 * everywhere else rather than claimed as a side effect of being read.
 */
async function accountClause(companyId) {
  const allowUnowned = await soleCompanyDeployment(companyId);
  return {
    $or: [
      { companyId },
      ...(allowUnowned ? [{ companyId: null }, { companyId: { $exists: false } }] : []),
    ],
  };
}

/**
 * One active SHIPPING address, on an account this company owns.
 *
 * @returns `{ destination }` or `{ reason }`. Never a document, and never a
 * partially-checked address a caller might use anyway.
 */
async function resolveShippingDestination(companyId, { addressId, accountId = null } = {}) {
  if (!oid(addressId)) return { destination: null, reason: REASON.NOT_FOUND };

  const clause = await accountClause(companyId);
  /* The account first, under the company clause — and the address is then
     looked for ON that account. Two scoped reads, never a global one. */
  const selector = { ...(oid(accountId) ? { _id: accountId } : {}), $and: [clause] };
  const accounts = await Account.find(selector).select("_id").lean();
  if (!accounts.length) return { destination: null, reason: REASON.NOT_FOUND };

  const doc = await CRMAddress.findOne({
    _id: addressId,
    accountId: { $in: accounts.map((a) => a._id) },
    isActive: true,
  }).lean();
  if (!doc) return { destination: null, reason: REASON.NOT_FOUND };

  /* ── THE TYPE IS A REQUIREMENT, NOT A PREFERENCE ────────────────────
     Disclosed as its own reason, because at this point the address IS this
     company's — the caller can already see it on the account, and telling
     them it is the billing one is the difference between a five-second fix
     and a mystery. */
  if (String(doc.addressType || "") !== "shipping") {
    return { destination: null, reason: REASON.NOT_SHIPPING, addressType: doc.addressType || null };
  }

  return {
    reason: null,
    destination: {
      addressId: String(doc._id),
      accountId: String(doc.accountId),
      addressType: doc.addressType,
      /* ── SNAPSHOTTED FROM THE RECORD, NEVER FROM THE REQUEST ────
         A label a caller supplies is a label a caller chose. The lane a
         rate is quoted against has to be the one the address actually
         says. */
      label: [doc.recipient, doc.addressLine1, doc.city].filter(Boolean).join(", "),
      city: doc.city || "",
      region: doc.region || "",
      country: doc.country || "",
      postalCode: doc.postalCode || "",
    },
  };
}

/** Every active shipping address the picker may offer for one account. */
async function shippingAddressesFor(companyId, accountId) {
  if (!oid(accountId)) return [];
  const clause = await accountClause(companyId);
  const oneSelector = { _id: accountId, $and: [clause] };
  const account = await Account.findOne(oneSelector).select("_id").lean();
  if (!account) return [];
  const docs = await CRMAddress.find({
    accountId: account._id, addressType: "shipping", isActive: true,
  }).sort({ isPrimaryForType: -1, updatedAt: -1 }).limit(50).lean();
  return docs.map((d) => ({
    id: String(d._id),
    label: [d.recipient, d.addressLine1, d.city].filter(Boolean).join(", "),
    city: d.city || "",
    region: d.region || "",
    country: d.country || "",
    postalCode: d.postalCode || "",
    isPrimaryForType: d.isPrimaryForType === true,
  }));
}

module.exports = { REASON, resolveShippingDestination, shippingAddressesFor };

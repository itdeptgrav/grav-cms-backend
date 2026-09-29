"use strict";
// services/inventory/materialOwnership.service.js
//
// A MATERIAL'S DEFAULT OWNERSHIP — THE ONE RULE, USED BY EVERY DOOR.
//
// Store's item form, the Development BOM's registration drawer, the edit
// route, the customer search behind the form and the receiving screens that
// preselect from the default all read this file, so none of them can accept a
// word the others refuse or trust a customer the others would not.
//
// ── WHAT THIS DECIDES, AND WHAT IT NEVER TOUCHES ────────────────────────────
// It decides two catalogue fields: `defaultOwnership` and `owningCustomerId`
// (with a display snapshot beside the id). It returns those fields and
// nothing else — no quantity, no movement, no lot, no valuation — so a caller
// that assigns exactly what it returns cannot move stock by accident. The
// tests pin that shape.
//
// ── THE CUSTOMER IS VALIDATED, NEVER TRUSTED ────────────────────────────────
// The client names a customer by id. That is acceptable here precisely
// because this is a DEFAULT: a receipt still resolves the owner of the stock
// it creates on the server, from the Sales chain
// (services/merchandising/customerIdentity.service.js), and never from this
// field. But a default naming a customer this company cannot reach would be
// a default nobody can act on, so the id is checked against the company's
// reach before it is stored:
//
//   · the customer must exist and be active;
//   · in a deployment with more than one company, this company must hold a
//     commercial record for the customer — an Account that links them, or an
//     order that proves them (services/sales/customerAccountLink.service.js,
//     the same rule Sales uses to say whose customer somebody is);
//   · in a sole-company deployment every active customer is reachable, which
//     is the same allowance the Sales scope makes for its own records.
//
// A missing, inactive and foreign customer share one answer, so a probe
// cannot learn which of the three it hit.
const mongoose = require("mongoose");
const Customer = require("../../models/Customer_Models/Customer");
const RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");
const {
  DEFAULT_OWNERSHIP, OWNERSHIP_WORDS, isDefaultOwnership, NO_OWNING_CUSTOMER,
} = require("../../models/CMS_Models/Inventory/Products/materialOwnership");
const { fail } = require("../storePurchase/errors");
const tenantContext = require("../storePurchase/tenantContext.service");
const { soleCompanyDeployment } = require("../companyContext/salesScope.service");
const customerAccountLink = require("../sales/customerAccountLink.service");
const { snapshotOf } = require("../merchandising/customerIdentity.service");

const str = (v) => String(v ?? "").trim();
const isId = (v) => mongoose.Types.ObjectId.isValid(str(v));

/** The one non-disclosing refusal for a customer this company cannot use. */
const CUSTOMER_NOT_AVAILABLE = "That customer is not available in this company.";

/* ── THE PAYLOAD, READ ONCE ───────────────────────────────────────────────────
   `present` says whether the caller spoke about ownership at all. An absent
   pair on an edit means "not part of this change"; on a create it means the
   default. A present-but-empty ownership word is a caller clearing it, which
   is not a thing this field supports — it is refused rather than guessed. */
function normaliseOwnershipInput(payload = {}) {
  const hasOwnership = payload.defaultOwnership !== undefined;
  const hasCustomer = payload.owningCustomerId !== undefined;
  if (!hasOwnership && !hasCustomer) {
    return { present: false, defaultOwnership: undefined, owningCustomerId: undefined };
  }
  let defaultOwnership;
  if (hasOwnership) {
    const word = str(payload.defaultOwnership).toUpperCase();
    if (!isDefaultOwnership(word)) {
      throw fail("VALIDATION",
        `Ownership must be ${DEFAULT_OWNERSHIP.COMPANY_OWNED} or ${DEFAULT_OWNERSHIP.CUSTOMER_OWNED}.`,
        { field: "defaultOwnership", allowed: Object.values(DEFAULT_OWNERSHIP) });
    }
    defaultOwnership = word;
  }
  let owningCustomerId;
  if (hasCustomer) {
    const raw = payload.owningCustomerId;
    if (raw === null || str(raw) === "") owningCustomerId = null;
    else if (!isId(raw)) {
      throw fail("VALIDATION", "That is not a customer reference this system issued.",
        { field: "owningCustomerId" });
    } else owningCustomerId = str(raw);
  }
  return { present: true, defaultOwnership, owningCustomerId };
}

/* ── THE DECISION, AS VALUES ─────────────────────────────────────────────────
   `stored` is the material as it is (null on a create). The result names the
   ownership that will stand, the customer that must be proved for it, and
   whether a customer id is being cleared — so a company-owned material can
   never keep a stale customer, and a customer-owned one can never lack one. */
function decideOwnership({ stored = null, payload = {} } = {}) {
  const input = normaliseOwnershipInput(payload);
  const current = {
    defaultOwnership: stored?.defaultOwnership || DEFAULT_OWNERSHIP.COMPANY_OWNED,
    owningCustomerId: stored?.owningCustomerId ? str(stored.owningCustomerId) : null,
  };
  if (!input.present) return { changed: false, ...current, customerToProve: null };

  const defaultOwnership = input.defaultOwnership || current.defaultOwnership;
  if (defaultOwnership === DEFAULT_OWNERSHIP.COMPANY_OWNED) {
    /* Whatever the payload or the record carried: company-owned means no
       customer, so a stale id is cleared here rather than kept "for later". */
    return { changed: true, defaultOwnership, owningCustomerId: null, customerToProve: null };
  }
  const customerId = input.owningCustomerId !== undefined ? input.owningCustomerId : current.owningCustomerId;
  if (!customerId) {
    throw fail("VALIDATION",
      "Name the owning customer. A customer-owned material must say whose property it is.",
      { field: "owningCustomerId", reason: "OWNING_CUSTOMER_REQUIRED" });
  }
  return {
    changed: true,
    defaultOwnership,
    owningCustomerId: customerId,
    /* Proved on every customer-owned save, even when the id is unchanged: a
       customer that was archived since is a default nobody can act on. */
    customerToProve: customerId,
  };
}

/* ── THE COMPANY'S REACH ──────────────────────────────────────────────────────
   The same scope shape the Sales helpers take, built from the Store tenant
   context rather than re-resolving the actor — one request, one company. */
async function reachOf(tenant) {
  const companyId = tenant?.companyId || null;
  if (!companyId) throw fail("TENANT_MEMBERSHIP_UNPROVEN", "Your company could not be established.");
  const allowUnowned = await soleCompanyDeployment(companyId);
  return {
    companyId,
    allowUnowned,
    clause: {
      $or: [
        { companyId },
        ...(allowUnowned ? [{ companyId: null }, { companyId: { $exists: false } }] : []),
      ],
    },
  };
}

/** The account states that mean "this company holds a record for them". */
const REACHABLE_LINK = new Set([
  customerAccountLink.STATE.LINKED,
  customerAccountLink.STATE.REPAIRABLE,
  customerAccountLink.STATE.AMBIGUOUS,
]);

/**
 * One active customer this company can reach, or a non-disclosing refusal.
 *
 * `deps` exists for the unit tests: the lookups are injectable so the rule can
 * be exercised without a database, and every caller in the application uses
 * the defaults.
 */
async function accessibleCustomer(tenant, customerId, { session = null, deps = {} } = {}) {
  const findCustomer = deps.findCustomer
    || ((id) => Customer.findOne({ _id: id, isActive: true })
      .select("_id name customerId profile.companyName isActive").session(session).lean());
  const reach = deps.reach || reachOf;
  const resolveLink = deps.resolveLink || customerAccountLink.resolve;

  if (!isId(customerId)) {
    throw fail("NOT_FOUND", CUSTOMER_NOT_AVAILABLE, { field: "owningCustomerId", reason: "OWNING_CUSTOMER_NOT_FOUND" });
  }
  const customer = await findCustomer(str(customerId));
  if (!customer || customer.isActive === false) {
    throw fail("NOT_FOUND", CUSTOMER_NOT_AVAILABLE, { field: "owningCustomerId", reason: "OWNING_CUSTOMER_NOT_FOUND" });
  }
  const scope = await reach(tenant);
  if (!scope.allowUnowned) {
    const link = await resolveLink({ scope, customerId: str(customer._id) });
    if (!REACHABLE_LINK.has(link?.state)) {
      throw fail("NOT_FOUND", CUSTOMER_NOT_AVAILABLE, { field: "owningCustomerId", reason: "OWNING_CUSTOMER_NOT_FOUND" });
    }
  }
  return customer;
}

/**
 * The two fields (plus the snapshot) a create or an edit should assign, and
 * NOTHING else. A caller spreads exactly this onto the record.
 *
 * @returns {Promise<{ changed: boolean, defaultOwnership: string,
 *                     owningCustomerId: ObjectId|null, owningCustomer: object }>}
 */
async function resolveOwnership(tenant, { stored = null, payload = {}, session = null, deps = {} } = {}) {
  const decided = decideOwnership({ stored, payload });
  if (!decided.changed) {
    return {
      changed: false,
      defaultOwnership: decided.defaultOwnership,
      owningCustomerId: decided.owningCustomerId ? new mongoose.Types.ObjectId(decided.owningCustomerId) : null,
      owningCustomer: stored?.owningCustomer
        ? {
          customerCode: str(stored.owningCustomer.customerCode),
          customerLabel: str(stored.owningCustomer.customerLabel),
          customerName: str(stored.owningCustomer.customerName),
        }
        : { ...NO_OWNING_CUSTOMER },
    };
  }
  if (decided.defaultOwnership === DEFAULT_OWNERSHIP.COMPANY_OWNED) {
    return {
      changed: true,
      defaultOwnership: DEFAULT_OWNERSHIP.COMPANY_OWNED,
      owningCustomerId: null,
      owningCustomer: { ...NO_OWNING_CUSTOMER },
    };
  }
  const customer = await accessibleCustomer(tenant, decided.customerToProve, { session, deps });
  const snap = snapshotOf(customer, null);
  return {
    changed: true,
    defaultOwnership: DEFAULT_OWNERSHIP.CUSTOMER_OWNED,
    owningCustomerId: new mongoose.Types.ObjectId(String(customer._id)),
    owningCustomer: {
      customerCode: snap.customerCode,
      customerLabel: snap.customerLabel,
      customerName: snap.customerName,
    },
  };
}

/* ── WHAT A SCREEN READS ──────────────────────────────────────────────────────
   One shape for the list, the detail, the pickers and the receiving screens:
   the word, the label, and the customer where there is one. Built from the
   stored fields, so an item written before the field existed reads as company
   owned rather than as nothing. */
function ownershipView(item) {
  const code = isDefaultOwnership(item?.defaultOwnership)
    ? str(item.defaultOwnership).toUpperCase()
    : DEFAULT_OWNERSHIP.COMPANY_OWNED;
  const customerOwned = code === DEFAULT_OWNERSHIP.CUSTOMER_OWNED;
  const snap = item?.owningCustomer || {};
  return {
    defaultOwnership: code,
    label: OWNERSHIP_WORDS[code],
    customer: customerOwned && item?.owningCustomerId
      ? {
        id: str(item.owningCustomerId),
        label: str(snap.customerLabel) || str(snap.customerName),
        name: str(snap.customerName),
        code: str(snap.customerCode),
      }
      : null,
  };
}

/**
 * The defaults of several materials at once — for a receiving screen that
 * shows, beside each line, what the catalogue says the goods normally are.
 * Read within the company; a foreign or missing id is simply absent from
 * the map, and the screen then says nothing rather than guessing.
 */
async function materialDefaultsFor(tenant, rawItemIds = [], session = null) {
  const ids = [...new Set((rawItemIds || []).map(str).filter(isId))];
  const out = new Map();
  if (!ids.length) return out;
  const rows = await RawItem.find({ ...tenantContext.tenantFilter(tenant), _id: { $in: ids } })
    .select("_id defaultOwnership owningCustomerId owningCustomer").session(session).lean();
  for (const r of rows) out.set(str(r._id), ownershipView(r));
  return out;
}

/**
 * Customers this company may name as an owning customer, by name, code or
 * trading name. The same reach rule as `accessibleCustomer`, so a customer
 * the search offers is a customer the save accepts.
 */
async function searchCustomers(tenant, { q = "", limit = 10 } = {}, { deps = {} } = {}) {
  const term = str(q);
  const cap = Math.max(1, Math.min(25, Number(limit) || 10));
  const filter = { isActive: true };
  if (term) {
    const re = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    filter.$or = [{ name: re }, { customerId: re }, { "profile.companyName": re }];
  }
  const find = deps.findCustomers
    || (() => Customer.find(filter).select("_id name customerId profile.companyName isActive")
      .sort({ name: 1 }).limit(cap * 3).lean());
  const candidates = await find(filter, cap * 3);
  const reach = deps.reach || reachOf;
  const scope = await reach(tenant);
  const resolveLink = deps.resolveLink || customerAccountLink.resolve;
  const reachable = [];
  for (const c of candidates) {
    if (reachable.length >= cap) break;
    if (!scope.allowUnowned) {
      const link = await resolveLink({ scope, customerId: str(c._id) });
      if (!REACHABLE_LINK.has(link?.state)) continue;
    }
    const snap = snapshotOf(c, null);
    reachable.push({ id: str(c._id), label: snap.customerLabel, name: snap.customerName, code: snap.customerCode });
  }
  return reachable;
}

module.exports = {
  DEFAULT_OWNERSHIP, OWNERSHIP_WORDS, CUSTOMER_NOT_AVAILABLE,
  normaliseOwnershipInput, decideOwnership, accessibleCustomer, resolveOwnership,
  ownershipView, materialDefaultsFor, searchCustomers, reachOf,
};

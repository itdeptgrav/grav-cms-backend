// services/sales/customerAccountLink.service.js
//
// ONE CUSTOMER, AS FAR AS A SALESPERSON IS CONCERNED.
//
// This system keeps two records of the same buyer: the portal `Customer` they
// log in with and place orders through, and the CRM `Account` that carries
// their commercial terms. That split is a fact about the database. It is not
// a fact about the person's job, and it has no business appearing on their
// screen — least of all as "this customer is not linked to a sales account
// yet", which names both models, explains neither, and sends somebody to a
// different page to fix a relationship they never knew existed.
//
// ── THE ROOT CAUSE ─────────────────────────────────────────────────────────
// `POST /api/cms/sales/customers` created the Customer and nothing else. Every
// customer Sales has ever created that way has no Account — so the commercial
// terms screen, which edits the Account, had nothing to edit and said so in
// the vocabulary of the schema. The creation path now establishes the
// relationship with the customer (see that route); this service is the one
// place that knows how.
//
// ── WHAT MAY ESTABLISH THE RELATIONSHIP, IN ORDER ──────────────────────────
//   1. LINKED    an account already points at this customer by id. Nothing to
//                do; it is somebody's deliberate choice and it wins outright.
//   2. REPAIRED  the customer placed an order, and an enquiry PROVES it is
//                that enquiry's order (`services/orderLinkProof.js`). The
//                enquiry names its account, so the account is proved too —
//                by ids the whole way, with no resemblance anywhere in it.
//   3. CREATED   nothing exists; one account is created and linked.
//
// ── AND WHAT MAY NOT ───────────────────────────────────────────────────────
// A NAME. Not the company name, not the trading name, not "close enough".
// Checked against this company's live data while building the order-link
// work: four of five real links would fail a name-similarity test while being
// entirely correct, and the one case that looked like a match was two
// different companies. A name is evidence of nothing, and linking a customer
// to the wrong account puts one buyer's terms on another buyer's invoice.
//
// Two accounts already claiming one customer is a real conflict on real data.
// It is REFUSED and reported for a person to resolve; nothing here picks a
// winner, and nothing here merges two genuine customers.
"use strict";

const mongoose = require("mongoose");

const Account = require("../../models/CMS_Models/Sales/Account");
const Enquiry = require("../../models/CMS_Models/Sales/Enquiry");
const CustomerRequest = require("../../models/Customer_Models/CustomerRequest");
const CustomerAccountClaim = require("../../models/CMS_Models/Sales/CustomerAccountClaim");
const orderLinkProof = require("../orderLinkProof");
const { ownershipFieldsFromScope } = require("../companyContext/salesScope.service");

const STATE = Object.freeze({
  LINKED: "LINKED",
  REPAIRABLE: "REPAIRABLE",
  ABSENT: "ABSENT",
  AMBIGUOUS: "AMBIGUOUS",
  ARCHIVED: "ARCHIVED",
});

const id = (v) => (v ? String(v) : "");
const oid = (v) => new mongoose.Types.ObjectId(String(v));

/** The company clause every read and write here is made under. */
const within = (scope, extra = {}) => ({ ...(scope?.clause || {}), ...extra });

/**
 * WHICH ACCOUNT IS THIS CUSTOMER'S, AND HOW DO WE KNOW.
 *
 * Reads only. Returns the state and, where there is one, the account — plus
 * everything a screen needs to say what is wrong without naming a model.
 */
async function resolve({ scope, customerId }) {
  if (!mongoose.Types.ObjectId.isValid(String(customerId))) {
    return { state: STATE.ABSENT, account: null, reason: "That is not a customer reference this system issued." };
  }
  const customer = oid(customerId);

  /* ── 1 · AN EXPLICIT LINK ───────────────────────────────────────────
     Two is not an answer. Asking for one row and taking it would edit
     whichever account happened to sort first, and the person would never
     learn the other one exists carrying different terms. */
  const live = await Account.find(within(scope, { linkedCustomer: customer, isActive: true }))
    .select("_id accountId companyName displayName companyId").limit(3).lean();
  if (live.length > 1) {
    return {
      state: STATE.AMBIGUOUS,
      account: null,
      candidates: live.map((a) => ({ id: id(a._id), name: a.displayName || a.companyName || a.accountId })),
      reason: "More than one commercial record already claims this customer, so their terms cannot be "
        + "shown here until somebody says which is theirs.",
    };
  }
  if (live.length === 1) return { state: STATE.LINKED, account: live[0], establishedBy: "LINKED" };

  /* An archived account is not a missing one: the terms are on a record
     somebody retired, and offering to create a second would make a duplicate
     of a decision that was already taken. */
  const archived = await Account.findOne(within(scope, { linkedCustomer: customer, isActive: false }))
    .select("_id accountId companyName displayName").lean();
  if (archived) {
    return {
      state: STATE.ARCHIVED,
      account: null,
      archived: { id: id(archived._id), name: archived.displayName || archived.companyName || archived.accountId },
      reason: "This customer's commercial record was archived. Restore it rather than starting a second one.",
    };
  }

  /* ── 2 · PROVED BY THE ORDER THEY ACTUALLY PLACED ───────────────────
     The customer's own orders, and an enquiry that PROVES one of them is
     its order. Ids the whole way: request → enquiry → account. */
  const repairable = await provenByOrder({ scope, customer });
  if (repairable) return { state: STATE.REPAIRABLE, account: repairable.account, via: repairable.via };

  return { state: STATE.ABSENT, account: null };
}

/**
 * The account an enquiry proves, through an order this customer placed.
 *
 * Only a link `orderLinkProof` calls EXACT counts: a stored
 * `customerRequestId` may be a guess made before that rule existed, and a
 * guess is exactly what must not establish a customer's commercial identity.
 */
async function provenByOrder({ scope, customer }) {
  const requests = await CustomerRequest.find({ customerId: customer })
    .select("_id requestId status salesOrigin").sort({ createdAt: -1 }).limit(25).lean();
  if (!requests.length) return null;

  const ids = requests.map((r) => r._id);
  const enquiries = await Enquiry.find(within(scope, {
    isActive: true,
    $or: [{ customerRequestId: { $in: ids } }, { "orderLink.customerRequestId": { $in: ids } }],
  })).select("_id enquiryId accountId customerRequestId orderLink companyId").limit(25).lean();

  /* `orderLinkProof` takes the company clause as a FUNCTION — it folds the
     caller's own scope into its reads rather than trusting one passed in. */
  const asScope = async (extra = {}) => ({ $and: [scope?.clause || {}, extra] });

  const accounts = new Map();
  for (const enquiry of enquiries) {
    /* eslint-disable no-await-in-loop */
    const proved = await orderLinkProof.proveExactOrderLink({ enquiry, scope: asScope });
    if (!proved.ok) continue;
    if (!requests.some((r) => id(r._id) === id(proved.request._id))) continue;
    accounts.set(id(enquiry.accountId), { enquiryRef: enquiry.enquiryId, requestId: proved.request._id });
  }
  /* Two different accounts have each proved an order by this customer. That
     is a real conflict — one portal login used by two companies, or an order
     linked to the wrong deal — and it is not this service's to settle. */
  if (accounts.size !== 1) return null;

  const [accountId, via] = [...accounts.entries()][0];
  const account = await Account.findOne(within(scope, { _id: oid(accountId), isActive: true }))
    .select("_id accountId companyName displayName companyId").lean();
  return account ? { account, via } : null;
}

/**
 * ESTABLISH THE RELATIONSHIP, ONCE.
 *
 * Idempotent by construction: the claim's `_id` IS the customer's id, so two
 * clicks half a second apart are one insert and one read of it. The loser
 * does not create a second account; it returns the first one's.
 *
 * @param {object} input
 * @param {object} input.scope     the caller's company clause and id
 * @param {string} input.customerId
 * @param {object} input.customer  the portal customer, for the name only
 * @param {object} [input.actor]   who asked
 * @param {boolean} [input.dryRun] report what would happen, write nothing
 */
async function ensure({ scope, customerId, customer = null, actor = null, dryRun = false }) {
  const found = await resolve({ scope, customerId });

  if (found.state === STATE.LINKED) return { ok: true, account: found.account, establishedBy: "LINKED", created: false };
  if (found.state === STATE.AMBIGUOUS || found.state === STATE.ARCHIVED) {
    return { ok: false, code: found.state, message: found.reason, candidates: found.candidates || null, archived: found.archived || null };
  }

  if (found.state === STATE.REPAIRABLE) {
    if (dryRun) return { ok: true, account: found.account, establishedBy: "REPAIRED", created: false, dryRun: true, via: found.via };
    const claimed = await claim({ customerId, account: found.account, scope, establishedBy: "REPAIRED", actor });
    if (!claimed.ok) return claimed;
    await Account.updateOne(
      within(scope, { _id: claimed.accountId, linkedCustomer: { $in: [null, undefined] } }),
      { $set: { linkedCustomer: oid(customerId) } },
    );
    const account = await Account.findOne(within(scope, { _id: claimed.accountId }))
      .select("_id accountId companyName displayName").lean();
    return { ok: true, account, establishedBy: "REPAIRED", created: false, via: found.via };
  }

  /* ── NOTHING EXISTS: ONE ACCOUNT, CREATED AND LINKED ────────────────
     Named from the customer's own record — their company name if they gave
     one, otherwise the name they registered under. A NAME IS NOT USED TO
     FIND anything here; it is only what the new record is called. */
  const name = String(
    customer?.profile?.companyName || customer?.businessInfo?.companyName || customer?.name || "",
  ).trim();
  if (!name) {
    return { ok: false, code: "NO_NAME", message: "This customer has no name recorded, so there is nothing to call their commercial record." };
  }
  if (dryRun) return { ok: true, account: null, establishedBy: "CREATED", created: true, dryRun: true, name };

  const accountId = new mongoose.Types.ObjectId();
  /* The claim first: it is the exclusive act. An account created before it
     and then losing the race would be an orphan nobody asked for. */
  const claimed = await claim({ customerId, account: { _id: accountId }, scope, establishedBy: "CREATED", actor });
  if (!claimed.ok) return claimed;

  if (id(claimed.accountId) !== id(accountId)) {
    /* Somebody else got there first, in the same second. Theirs is the
       answer — which is what idempotent means here. */
    const account = await Account.findOne(within(scope, { _id: claimed.accountId }))
      .select("_id accountId companyName displayName").lean();
    return { ok: true, account, establishedBy: claimed.establishedBy, created: false };
  }

  const created = await Account.create({
    _id: accountId,
    companyName: name,
    displayName: name,
    status: "active",
    linkedCustomer: oid(customerId),
    /* Ownership is the caller's own, proved and stamped exactly as every
       other account create stamps it — never taken from a request. */
    ...ownershipFieldsFromScope(scope),
    sourceSystem: "SALES_CUSTOMER",
    ...(actor ? { createdBy: actor, updatedBy: actor, assignedTo: actor.id, assignedToName: actor.name } : {}),
  });
  return {
    ok: true,
    account: { _id: created._id, accountId: created.accountId, companyName: created.companyName, displayName: created.displayName },
    establishedBy: "CREATED",
    created: true,
  };
}

/**
 * The exclusive act. First writer wins; everybody else reads their answer.
 *
 * Keyed per COMPANY: the same portal login can buy from two of this group's
 * companies, and each keeps its own commercial record of them. A key on the
 * customer alone would make the second company's setup collide with the
 * first's and hand it a record it is not allowed to see.
 */
const claimKey = (scope, customerId) => `${id(scope?.companyId)}:${id(customerId)}`;

async function claim({ customerId, account, scope, establishedBy, actor }) {
  try {
    const doc = await CustomerAccountClaim.create({
      _id: claimKey(scope, customerId),
      customerId: oid(customerId),
      accountId: account._id,
      companyId: scope?.companyId,
      establishedBy,
      establishedByUser: actor ? { id: actor.id, name: actor.name } : undefined,
    });
    return { ok: true, accountId: doc.accountId, establishedBy };
  } catch (err) {
    if (err?.code !== 11000) throw err;
    const existing = await CustomerAccountClaim.findById(claimKey(scope, customerId)).lean();
    if (!existing) throw err;
    return { ok: true, accountId: existing.accountId, establishedBy: existing.establishedBy };
  }
}

module.exports = { STATE, resolve, ensure, provenByOrder };

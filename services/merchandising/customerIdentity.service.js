"use strict";
// services/merchandising/customerIdentity.service.js
//
// WHOSE GOODS THESE ARE — AS AN IDENTITY, NOT A LABEL.
//
// A customer-supplied material document says the CUSTOMER is sending the fabric.
// For a piece of paper, `buyerDisplayLabel` is enough: somebody reads it and
// knows who is meant. For INVENTORY OWNERSHIP it is not remotely enough, and the
// difference is the whole reason this file exists.
//
// ── WHY A DISPLAY LABEL CANNOT OWN STOCK ────────────────────────────────────
// `buyerDisplayLabel` is a string Sales composed for a human to read. Three
// things are true of it and fatal here:
//
//   · it is not unique — two buyers at one group, or a company and its trading
//     arm, routinely read the same;
//   · it changes — a rename, a merger, a corrected spelling, and every lot
//     already on the shelf silently belongs to somebody slightly different;
//   · it is not a reference — nothing joins to it, so "show me everything we
//     hold for this customer" becomes a text search, and a text search that
//     misses is indistinguishable from a customer who sent nothing.
//
// Customer-owned stock has to be provable: this lot is that customer's, that
// order's, that line's, and no amount of renaming changes it. So ownership is
// carried by the Customer's own id, and the label travels beside it as a
// SNAPSHOT — what it read at the moment of receipt, for reading a document back
// as it was, never as the thing joined on.
//
// ── THE CHAIN, AND WHY IT IS FOLLOWED RATHER THAN ASKED FOR ─────────────────
//
//   ExecutionFile.currentHandoverVersionId
//     → SalesHandoverVersion (loaded SCOPED TO THIS COMPANY)
//       → sourceRecord.recordId  — the Customer Request Sales confirmed
//         → CustomerRequest.customerId  — the Customer
//
// Every link is read on the server. `customerId` is NEVER accepted from a
// client: a payload that names a customer would let anybody attribute stock to
// anybody, which is worse than useless — it is a way to move goods off one
// customer's book and onto another's by editing a form.
//
// ── WHERE THE COMPANY PROOF COMES FROM ──────────────────────────────────────
// `CustomerRequest` carries no `companyId` — it predates company ownership on
// the Sales side. So the boundary is held one link earlier: the Execution File
// is company-scoped, and the handover version is loaded with an explicit
// `companyId` filter. The request is reached ONLY through a handover this
// company owns, so a request belonging to another company's order is
// unreachable rather than merely unselected. That is stated here because the
// absence of a `companyId` on the final document invites somebody to add a
// direct lookup later, which would open exactly the hole this avoids.
//
// ── AND IT REFUSES RATHER THAN GUESSING ─────────────────────────────────────
// A broken chain returns a reason, never a fallback. A lot stamped with a
// guessed customer is worse than a receipt that could not be recorded: the
// receipt is visibly missing, and the wrong owner is invisible until somebody
// ships another customer's fabric.

const mongoose = require("mongoose");

const ExecutionFile = require("../../models/CMS_Models/Merchandising/ExecutionFile");
const SalesHandoverVersion = require("../../models/CMS_Models/Sales/SalesHandoverVersion");
const CustomerRequest = require("../../models/Customer_Models/CustomerRequest");
const Customer = require("../../models/Customer_Models/Customer");
/* The development chain: a sample has no execution file, so its customer is
   established through the Sales journey it was opened under. */
const { DevelopmentFile } = require("../../models/CMS_Models/Merchandising/Development");
const SalesJourney = require("../../models/CMS_Models/Sales/SalesJourney");
const Account = require("../../models/CMS_Models/Sales/Account");

const str = (v) => String(v ?? "").trim();
const isId = (v) => mongoose.Types.ObjectId.isValid(str(v));

/** Why a chain could not be walked. Stable, so a screen can explain each one. */
const UNPROVEN = Object.freeze({
  NO_HANDOVER_VERSION: "NO_HANDOVER_VERSION",
  /* ── THE DEVELOPMENT CHAIN ──────────────────────────────────────────────
     A development sample has no execution file and no handover version: there
     is no confirmed order behind it yet. Its customer is established through
     the Sales journey the development belongs to, which is a different walk
     with its own ways of being broken — so it has its own reasons rather than
     borrowing the order chain's and reporting a handover that was never
     expected to exist. */
  DEVELOPMENT_NOT_FOUND: "DEVELOPMENT_NOT_FOUND",
  NO_JOURNEY: "NO_JOURNEY",
  JOURNEY_NOT_FOUND: "JOURNEY_NOT_FOUND",
  ACCOUNT_NOT_NAMED: "ACCOUNT_NOT_NAMED",
  ACCOUNT_NOT_FOUND: "ACCOUNT_NOT_FOUND",
  ACCOUNT_NOT_LINKED_TO_CUSTOMER: "ACCOUNT_NOT_LINKED_TO_CUSTOMER",
  HANDOVER_VERSION_NOT_FOUND: "HANDOVER_VERSION_NOT_FOUND",
  SOURCE_RECORD_MISSING: "SOURCE_RECORD_MISSING",
  CUSTOMER_REQUEST_NOT_FOUND: "CUSTOMER_REQUEST_NOT_FOUND",
  CUSTOMER_NOT_NAMED: "CUSTOMER_NOT_NAMED",
  CUSTOMER_NOT_FOUND: "CUSTOMER_NOT_FOUND",
});

/** What each refusal means to a person who has to fix it. */
const UNPROVEN_MESSAGE = Object.freeze({
  [UNPROVEN.NO_HANDOVER_VERSION]:
    "This execution file names no Sales handover version, so the customer it belongs to cannot be established.",
  [UNPROVEN.HANDOVER_VERSION_NOT_FOUND]:
    "The Sales handover version this file was opened from is not in this company.",
  [UNPROVEN.SOURCE_RECORD_MISSING]:
    "The Sales handover version names no customer request, so the customer cannot be established.",
  [UNPROVEN.CUSTOMER_REQUEST_NOT_FOUND]:
    "The customer request behind this order was not found.",
  [UNPROVEN.CUSTOMER_NOT_NAMED]:
    "The customer request behind this order names no customer. Ask Sales to attach one before "
    + "customer-supplied material is received against it.",
  [UNPROVEN.CUSTOMER_NOT_FOUND]:
    "The customer named on the request behind this order was not found.",
  [UNPROVEN.DEVELOPMENT_NOT_FOUND]:
    "That development was not found in this company.",
  [UNPROVEN.NO_JOURNEY]:
    "This development names no Sales journey, so the customer it belongs to cannot be established.",
  [UNPROVEN.JOURNEY_NOT_FOUND]:
    "The Sales journey this development belongs to is not in this company.",
  [UNPROVEN.ACCOUNT_NOT_NAMED]:
    "The Sales journey behind this development names no account, so the customer cannot be established.",
  [UNPROVEN.ACCOUNT_NOT_FOUND]:
    "The account on the Sales journey behind this development was not found.",
  [UNPROVEN.ACCOUNT_NOT_LINKED_TO_CUSTOMER]:
    "The account behind this development is not linked to a customer record yet. Ask Sales to link it "
    + "before customer-supplied material is expected against it.",
});

/* ── THE DISPLAY SNAPSHOT ────────────────────────────────────────────────────
   What the customer read as, at the moment it was stamped. Deliberately small:
   a name, the trading name where there is one, and the human code somebody
   would quote on a phone call.

   NOT the GST number, not an address, not a contact. Ownership needs to say
   WHOSE goods these are; it does not need the customer's tax registration, and
   a Store screen that had one would sooner or later show it. */
function snapshotOf(customer, request) {
  const trading = str(customer?.profile?.companyName);
  const name = str(customer?.name);
  return {
    /* The human code Sales assigns, quotable and stable. Not the identity. */
    customerCode: str(customer?.customerId),
    /* One line for a screen. The trading name wins where there is one, because
       that is what appears on a delivery note. */
    customerLabel: trading || name,
    customerName: name,
    /* Which confirmed request this ownership descends from, so a lot can be
       traced to the commercial document without a second join. */
    requestRef: str(request?.requestId),
  };
}

/**
 * Resolve, from an execution file, the customer whose goods these will be.
 *
 * @returns {Promise<{ok: true, customerId: ObjectId, snapshot: object,
 *                     customerRequestId: ObjectId}
 *                  |{ok: false, reason: string, message: string}>}
 *
 * Returns rather than throws. Two callers want different things from a broken
 * chain: issuing REFUSES, and a read wants to say "this cannot be received
 * until Sales attaches a customer" while still showing the document. A thrown
 * error makes the second one awkward enough that somebody swallows it.
 */
async function resolveFromFile(ctx, file, session = null) {
  const refuse = (reason) => ({ ok: false, reason, message: UNPROVEN_MESSAGE[reason] });

  const versionId = file?.currentHandoverVersionId;
  if (!versionId || !isId(versionId)) return refuse(UNPROVEN.NO_HANDOVER_VERSION);

  /* ── THE COMPANY BOUNDARY, HELD HERE ──────────────────────────────────────
     Scoped explicitly. This is the last link that carries a `companyId`, so a
     lookup that skipped it would reach another company's request through an id
     alone. */
  const version = await SalesHandoverVersion
    .findOne({ _id: versionId, companyId: ctx.companyId })
    .select("sourceRecord")
    .session(session).lean();
  if (!version) return refuse(UNPROVEN.HANDOVER_VERSION_NOT_FOUND);

  const requestId = version.sourceRecord?.recordId;
  if (!requestId || !isId(requestId)) return refuse(UNPROVEN.SOURCE_RECORD_MISSING);

  /* Reached only through the company-scoped handover above — see the header. */
  const request = await CustomerRequest
    .findById(requestId).select("customerId requestId")
    .session(session).lean();
  if (!request) return refuse(UNPROVEN.CUSTOMER_REQUEST_NOT_FOUND);

  const customerId = request.customerId;
  if (!customerId || !isId(customerId)) return refuse(UNPROVEN.CUSTOMER_NOT_NAMED);

  const customer = await Customer
    .findById(customerId).select("name customerId profile.companyName")
    .session(session).lean();
  if (!customer) return refuse(UNPROVEN.CUSTOMER_NOT_FOUND);

  return {
    ok: true,
    customerId: customer._id,
    customerRequestId: request._id,
    snapshot: snapshotOf(customer, request),
  };
}

/** The same, from a file id, for a caller that does not already hold the file. */
async function resolveFromFileId(ctx, fileId, session = null) {
  const file = await ExecutionFile
    .findOne({ _id: fileId, companyId: ctx.companyId })
    .select("currentHandoverVersionId")
    .session(session).lean();
  if (!file) {
    return {
      ok: false,
      reason: UNPROVEN.HANDOVER_VERSION_NOT_FOUND,
      message: UNPROVEN_MESSAGE[UNPROVEN.HANDOVER_VERSION_NOT_FOUND],
    };
  }
  return resolveFromFile(ctx, file, session);
}

/**
 * WHOSE GOODS THESE ARE, FOR A DEVELOPMENT SAMPLE.
 *
 * ── A DIFFERENT WALK, FOR A DIFFERENT REASON ───────────────────────────────
 * The order chain starts at an execution file and walks its handover version to
 * the customer request that was confirmed. A development has none of that: it
 * exists BEFORE anybody confirms an order, which is the entire point of it. What
 * it does have is the Sales journey it was opened under, and that journey names
 * the account the conversation is with.
 *
 *   Development → journeyId → SalesJourney.accountId → Account.linkedCustomer
 *
 * The last hop is the one that matters and the one that is allowed to fail. An
 * account is a CRM record of a conversation; a Customer is the commercial master
 * that can own stock. They are deliberately separate, and an account nobody has
 * linked yet is an ordinary state early in a development — so this refuses
 * rather than inventing a customer, and the refusal names the fix.
 *
 * ── AND IT IS NEVER TAKEN FROM A PAYLOAD ───────────────────────────────────
 * Same rule as the order chain, for the same reason: a client that could name
 * the customer could attribute one customer's fabric to another by editing a
 * form. The MRF is the demand and the audit root; it is not the authority for
 * ownership.
 */
async function resolveFromDevelopmentId(ctx, developmentId, session = null) {
  const refuse = (reason) => ({ ok: false, reason, message: UNPROVEN_MESSAGE[reason] });
  if (!isId(developmentId)) return refuse(UNPROVEN.DEVELOPMENT_NOT_FOUND);

  /* Company-scoped: this is the boundary, and a lookup by id alone would reach
     another company's development. */
  const development = await DevelopmentFile
    .findOne({ _id: developmentId, companyId: ctx.companyId })
    .select("journeyId developmentNumber productName styleRef buyerDisplayLabel currentRequestId")
    .session(session).lean();
  if (!development) return refuse(UNPROVEN.DEVELOPMENT_NOT_FOUND);

  if (!isId(development.journeyId)) return refuse(UNPROVEN.NO_JOURNEY);
  const journey = await SalesJourney
    .findOne({ _id: development.journeyId, companyId: ctx.companyId })
    .select("accountId journeyRef")
    .session(session).lean();
  if (!journey) return refuse(UNPROVEN.JOURNEY_NOT_FOUND);
  if (!isId(journey.accountId)) return refuse(UNPROVEN.ACCOUNT_NOT_NAMED);

  /* ── COMPANY-SCOPED, EVEN THOUGH THE JOURNEY ALREADY WAS ────────────────
     The journey is scoped, so in a sound database this hop cannot cross. But
     "the previous link was checked" is exactly the reasoning that leaves one
     unchecked link in a chain, and this is the hop that decides whose fabric
     arrives. An account in another company is refused as not found rather than
     followed on the strength of an id. */
  const account = await Account
    .findOne({ _id: journey.accountId, companyId: ctx.companyId })
    .select("linkedCustomer companyName")
    .session(session).lean();
  if (!account) return refuse(UNPROVEN.ACCOUNT_NOT_FOUND);
  /* `Account.linkedCustomer` is the link every reader uses — see
     `CustomerAccountClaim`, which records the decision rather than replacing
     it. An unlinked account is an ordinary early state, not a fault. */
  if (!isId(account.linkedCustomer)) return refuse(UNPROVEN.ACCOUNT_NOT_LINKED_TO_CUSTOMER);

  const customer = await Customer
    .findById(account.linkedCustomer).select("name customerId profile.companyName")
    .session(session).lean();
  if (!customer) return refuse(UNPROVEN.CUSTOMER_NOT_FOUND);

  return {
    ok: true,
    customerId: customer._id,
    /* A development has no confirmed customer request; the journey is what it
       has, and saying so is better than leaving a field that implies one. */
    customerRequestId: null,
    development: {
      id: development._id,
      number: str(development.developmentNumber),
      productName: str(development.productName),
      styleRef: str(development.styleRef),
      buyerDisplayLabel: str(development.buyerDisplayLabel),
    },
    snapshot: snapshotOf(customer, null),
  };
}

module.exports = {
  UNPROVEN, UNPROVEN_MESSAGE,
  resolveFromFile, resolveFromFileId, resolveFromDevelopmentId, snapshotOf,
};

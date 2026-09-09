/**
 * services/spendRequestCreate.service.js
 *
 * RAISING A SPEND REQUEST — the part that is the same however it was asked for.
 *
 * ── WHY THIS IS NOT IN THE ROUTE ANY MORE ───────────────────────────────────
 * There are now two ways a spend request comes into being:
 *
 *   1 · somebody fills the purchase/service form directly (the older door,
 *       still open — see routes/CMS_Routes/Requests/spendRequests.js)
 *   2 · a unified intake request is classified as something that has to be
 *       bought, repaired or subscribed to (see requestIntake.service.js)
 *
 * Both must match the same budget the same way, snapshot the same figures and
 * start in the same place, or finance would be looking at two kinds of request
 * that only appear to be alike. A second copy of this in the classification
 * route is how that divergence starts.
 *
 * What did NOT move is validation. Each door validates its own input, in its
 * own words, because the two are shaped differently — a form field somebody
 * typed wrong deserves a different sentence from a classification that arrived
 * without an account head. By the time anything reaches this file the caller
 * has already decided the ask is well-formed; this decides what it costs the
 * budget and where it starts.
 *
 * ── THE ARITHMETIC IS UNCHANGED ─────────────────────────────────────────────
 * Line amounts and the total are the caller's, already computed as quantity ×
 * rate and summed — the same numbers the route computed before this file
 * existed. Nothing here re-derives, rounds or adjusts them.
 */

"use strict";

const SpendRequest = require("../models/CMS_Models/Requests/SpendRequest");
const budgetMatch = require("./budgetCommitment.service");
const chain = require("./spendApproval.service");
const vocabulary = require("./budgetAllocationVocabulary");

/**
 * Which envelope this asks to use.
 *
 * Matched once, at the moment of raising, against the cycle in force TODAY —
 * and stored, so finance approving next month sees the head it was raised
 * against rather than whichever one it would match then.
 *
 * A miss is never a refusal. Every status is recorded and the request goes
 * forward regardless: an unbudgeted ask is a real ask, and refusing it here
 * would move that spending somewhere nobody is measuring.
 */
async function matchBudget({ asksForNewHead, companyId, department, ledger, totalAmount, when }) {
  const none = {
    status: "no_budget_line",
    budgetId: null,
    budgetLineId: null,
    financialYear: null,
    department: null,
    snapshot: null,
  };

  /* A request asking for a head that does not exist yet has nothing to check
     availability against, and running the check would produce a confident "no
     budget line" that reads as a fault rather than as the thing the request is
     openly asking for. */
  if (asksForNewHead || !ledger) return none;

  try {
    return await budgetMatch.matchFor({
      companyId,
      department: department || "",
      ledgerId: ledger._id,
      ledgerName: ledger.name,
      amount: totalAmount,
      when,
    });
  } catch (e) {
    /* A budget read that fails must not stop somebody asking for a repair. */
    console.error("[spend] budget match failed, recording as unmatched:", e.message);
    return none;
  }
}

/**
 * Create the request.
 *
 * `startAt` and `tlApproval` are the whole reason this takes options rather
 * than deriving everything: a request that reached here BY CLASSIFICATION has
 * already had its need agreed by the requester's manager, and sending it back
 * to that same manager would be asking the same person the same question
 * twice. It starts at finance, with the TL's earlier yes carried across so the
 * record says who agreed and when rather than quietly showing no approval at
 * all.
 *
 * @returns {Promise<{ request: object }>} the saved document, as a plain object
 */
async function createSpendRequest({
  emp,
  actorName,
  company,
  title,
  purpose,
  requestType,
  priority = "NORMAL",
  neededBy = null,
  vendorName = "",
  gstin = "",
  /* The vendor's reference for the quote being approved. */
  quoteRef = "",
  /* When the store expects the thing to land. Captured at the fulfilment
     decision because that is where the vendor is chosen, and finance reads it
     as part of what it is approving — a rate is only half of an offer. */
  expectedDeliveryDate = null,
  lines,
  totalAmount,
  /* ── TAX, WHERE THE STORE KNEW IT ────────────────────────────────────────
     Optional, and absent on every path that existed before this. `totalAmount`
     stays the subtotal it has always been; `grandTotal` is what will actually
     leave the bank once tax is on it. */
  gstPercent = 0,
  taxAmount = 0,
  grandTotal = null,
  ledger = null,
  asksForNewHead = false,
  requestedHeadName = "",
  requestedHeadReason = "",
  attachments = [],
  /* Who this waits on, resolved from the requester's own HR record before we
     get here — see mrfApprover.approverPatchFor. Spread onto the document
     whole, including the alternate ids and the reason, so no caller can store
     half of it and leave a request that names an approver nobody can match. */
  approver = {
    approverEmployee: null,
    approverName: "",
    approverBiometricId: "",
    approverAltIds: [],
    approverResolution: "RESOLVED",
    approverResolutionNote: "",
  },
  startAt = null,
  tlApproval = null,
  recurring = null,
  intakeRequestId = null,
  /* The row of the plan this spends against, carried from the intake request
     so finance approves against what was actually agreed. */
  plannedItem = null,
  historyNote = "",
  now = new Date(),
}) {
  /* Committed against the figure that will actually be paid. A commitment
     raised on the pre-tax subtotal under-reserves the head by the tax, and the
     shortfall only shows up when the voucher posts and the head is suddenly
     over. Falls back to `totalAmount` when no tax was captured, so every
     caller that predates this behaves exactly as it did. */
  const commitAmount = typeof grandTotal === "number" && grandTotal > 0 ? grandTotal : totalAmount;

  const budget = await matchBudget({
    asksForNewHead,
    companyId: company._id,
    department: emp.department,
    ledger,
    totalAmount: commitAmount,
    when: now,
  });

  const status =
    startAt ||
    chain.startingStatus({
      managesPeople: false,
      hasApprover: !!approver.approverEmployee,
    });

  /* ── EVERY NEW SERVICE REQUEST IS STAMPED, ON EVERY DOOR ────────────────
     This is the one function all three creation paths go through — the
     requests router, the intake conversion and the MRF route — so stamping
     here is what makes the rule unavoidable rather than something two of the
     three doors happen to do.

     A PRODUCT request is not stamped: it has no service lines to classify,
     and marking it would make it look like a request the service gate had
     opinions about. */
  const classifiedPolicy = (requestType === "SERVICE" || requestType === "SOFTWARE")
    ? vocabulary.SERVICE_CLASSIFICATION_POLICY
    : undefined;

  const created = await SpendRequest.create({
    title,
    requestType,
    /* Server-controlled. Never read from the caller's payload — a request that
       could name its own policy could opt itself out of the rule. */
    serviceClassificationPolicy: classifiedPolicy,
    requestedBy: emp._id,
    requestedByName: actorName,
    /* `identityId` as the fallback, matching what the intake door writes and
       what a CoWork session may present. A blank id here would make the
       request unmatchable to its own requester — no self-approval guard, and
       it would never appear in their own list. */
    requestedById: emp.biometricId || emp.identityId || "",
    department: emp.department || "",
    companyId: company._id,
    ledgerId: ledger ? ledger._id : undefined,
    /* The proposed name stands in for a head that does not exist yet, so every
       screen has something to call it. */
    ledgerName: ledger ? ledger.name : requestedHeadName,
    unbudgetedHeadRequest: asksForNewHead,
    requestedHeadName: asksForNewHead ? requestedHeadName : undefined,
    requestedHeadReason: asksForNewHead ? requestedHeadReason : undefined,
    /* Predetermined for this path — there is no envelope, so finance's yes can
       only ever be an unbudgeted one. The finance step recomputes the same
       answer; this is here so the request says what it is from the moment it
       is raised. */
    budgetApprovalKind: asksForNewHead ? "unbudgeted" : undefined,
    vendorName,
    gstin,
    quoteRef,
    expectedDeliveryDate,
    neededBy,
    priority,
    purpose,
    items: lines,
    totalAmount,
    gstPercent,
    taxAmount,
    grandTotal: typeof grandTotal === "number" ? grandTotal : totalAmount,
    attachments,
    recurring: recurring || undefined,
    intakeRequestId: intakeRequestId || undefined,
    plannedItemKey: plannedItem?.key || undefined,
    plannedItemName: plannedItem?.name || undefined,
    plannedItemAmount:
      typeof plannedItem?.amount === "number" ? plannedItem.amount : undefined,
    budgetCycleId: budget.budgetId || undefined,
    budgetLineId: budget.budgetLineId || undefined,
    budgetFinancialYear: budget.financialYear || undefined,
    budgetDepartment: budget.department || emp.department || "",
    budgetAccountHeadId: ledger ? ledger._id : undefined,
    budgetMatchStatus: budget.status,
    budgetSnapshot: budget.snapshot || undefined,
    status,
    ...approver,
    /* Carried, not re-asked. See the note on `tlApproval` above. */
    ...(tlApproval
      ? {
          tlApprovedBy: tlApproval.by || undefined,
          tlApprovedByName: tlApproval.byName || "",
          tlApprovedAt: tlApproval.at || now,
        }
      : {}),
    submittedAt: now,
    /* ── PRICED AT CREATION, ON EVERY PATH THAT REACHES HERE ─────────────
       `buildLines` on both doors already refuses a line without a rate, so a
       request cannot be created unpriced — this records WHEN that was true so
       finance's gate has one field to read rather than re-deriving it from
       the lines every time. Store's fulfilment decision overwrites it with
       the person who actually did the pricing. */
    pricedByName: actorName || "",
    pricedAt: now,
    history: [
      { at: now, by: emp._id, byName: actorName, action: "submitted", note: historyNote },
    ],
  });

  return { request: created };
}

module.exports = { createSpendRequest, matchBudget };

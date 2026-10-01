// services/storePurchase/governedPurchaseOrder.service.js
//
// THE ONE AUTHORITY THAT DECIDES WHETHER A MATERIAL PURCHASE ORDER MAY EXIST.
//
// ── THE CHAIN ───────────────────────────────────────────────────────────────
//   material request (MRF)      the operational need, and the stock shortfall
//        ↓                      that could not be issued off the shelf
//   PRODUCT spend request       sourcing, Finance approval, budget ownership
//        ↓
//   purchase order              the commitment to a supplier
//
// The MRF proves WHY the material is needed. The spend request remains the
// authority for sourcing, Finance approval, budget ownership and commitment —
// an MRF by itself is not budget approval, and this service never treats it as
// though it were.
//
// ── WHY ONE SERVICE AND NOT A CHECK IN EACH ROUTE ───────────────────────────
// Two entry points raise a material order: the New purchase order form, and
// Create purchase order on an approved request. Written separately they would
// drift, and the weaker of the two becomes the way round the rule. Both call
// this, so both get the same validation, the same provenance and the same
// refusals.
//
// ── WHAT IT NEVER TRUSTS ────────────────────────────────────────────────────
// Anything from the browser except the MRF it is asking about. Company,
// supplier, item identity, quantity, rate, tax and totals are all reloaded from
// the stored records — a client may say which need it is ordering against, and
// nothing else.
//
// ── WHAT IT DOES NOT DO ─────────────────────────────────────────────────────
// It creates no budget commitment, reserves no budget, posts no stock and
// writes no Accounting entry. The approved request already owns the commitment;
// the order simply carries the provenance that lets the eventual bill discharge
// the right one.
"use strict";

const mongoose = require("mongoose");

const MRF = require("../../models/CMS_Models/Inventory/Operations/MRF");
const SpendRequest = require("../../models/CMS_Models/Requests/SpendRequest");
const PurchaseOrder = require("../../models/CMS_Models/Inventory/Operations/PurchaseOrder");
const Vendor = require("../../models/CMS_Models/Inventory/Vendor-Buyer/Vendor");
const Acc_BudgetCommitment = require("../../models/Accountant_model/Acc_BudgetCommitment");
/* Finance's own allocation arithmetic — the one place an approved total is
   split across lines, header adjustment and last-line remainder included. */
const lineAllocation = require("../lineAllocation.service");
/* The one rule for what a request's commercial adjustments come to. */
const spendAdjustments = require("../spendAdjustments.service");

const { fail } = require("./errors");
const tenantContext = require("./tenantContext.service");

/* ── THE VOCABULARY, TAKEN FROM THE RECORDS THEMSELVES ─────────────────────
   Not redefined here: these are the values the spend chain already uses, and a
   second copy that drifts is how a request becomes orderable in one screen and
   not in another. */

/** The one status a purchase order may be raised from. */
const ORDERABLE_STATUS = "approved";

/** A material request. `SOFTWARE` is a legacy service and is not one. */
const MATERIAL_REQUEST_TYPE = "PRODUCT";

/**
 * Orders that have CONSUMED approved quantity.
 *
 * A cancelled order bought nothing, so the money it named is available again.
 * Counting it would permanently strand the approved quantity behind an order
 * somebody deliberately withdrew.
 */
const CONSUMES_QUANTITY = Object.freeze(["DRAFT", "ISSUED", "PARTIALLY_RECEIVED", "COMPLETED"]);

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const money = (v) => Math.round(num(v) * 100) / 100;
/* Half a paisa. Money is stored to two places, so two figures that agree to
   within this are the same figure; anything larger is a real difference. */
const TOLERANCE = 0.005;
const sameMoney = (a, b) => Math.abs(money(a) - money(b)) <= TOLERANCE;

/**
 * The one rule for comparing two lists of custom charges.
 *
 * ── WHY COUNT AND TOTAL ARE NOT ENOUGH ──────────────────────────────────────
 * Comparing only how many and how much treats these as identical:
 *     approved  Handling ₹200, Insurance ₹50
 *     ordered   Freight  ₹100, Other     ₹150
 * Two charges, ₹250 either way — and an order that says the company is paying
 * for something Finance never agreed to. Finance approved the MEANING of each
 * charge as well as its amount.
 *
 * ── ORDER IS NOT BUSINESS-SIGNIFICANT ───────────────────────────────────────
 * A charge list is a set of agreed costs, not a sequence: "freight then
 * handling" and "handling then freight" are the same agreement, and refusing
 * one because a form reordered it would be a refusal about nothing. So the
 * comparison is a canonical MULTISET of `normalised label + amount`, sorted so
 * the same pair always compares equal, with duplicates preserved — two ₹50
 * "Handling" rows are ₹100 of handling, and collapsing them would hide one.
 */
const chargeKey = (c) => `${String(c?.label || "").trim().toLowerCase().replace(/\s+/g, " ")}|${money(c?.amount).toFixed(2)}`;
const chargeSignature = (list) => (Array.isArray(list) ? list : [])
  .filter((c) => c && String(c.label || "").trim())
  .map(chargeKey)
  .sort()
  .join(" · ");
const sameCharges = (a, b) => chargeSignature(a) === chargeSignature(b);
const idOf = (v) => (v === null || v === undefined ? null : String(v));
/* Present and readable, as distinct from absent — `Number(null)` is 0. */
const usableNumber = (v) => v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v));

/**
 * The MRF, proven to be this company's.
 *
 * ── WHY A MISSING MRF AND A FOREIGN ONE ANSWER THE SAME ─────────────────────
 * Telling a caller "that MRF exists but is not yours" confirms the record, its
 * number and that another company has one. The difference IS the leak, so both
 * answer `MRF_UNAVAILABLE` and neither carries anything from the document.
 */
async function loadMrf(tenant, sourceMrfId) {
  const asked = idOf(sourceMrfId) || "";
  if (!asked) {
    throw fail("MRF_REQUIRED",
      "Choose the material request this purchase is for. Every material purchase order must say which request it fulfils.",
      { field: "sourceMrfId" });
  }
  if (!mongoose.isValidObjectId(asked)) {
    throw fail("MRF_UNAVAILABLE",
      "That material request could not be found.", { field: "sourceMrfId" });
  }
  const mrf = await MRF.findOne({
    _id: asked,
    ...tenantContext.tenantFilter(tenant),
  }).lean();
  if (!mrf) {
    throw fail("MRF_UNAVAILABLE",
      "That material request could not be found.", { field: "sourceMrfId" });
  }
  return mrf;
}

/**
 * The lines this MRF decided to BUY.
 *
 * ── `buyQty`, NEVER `requestedQty − issuedQty` ──────────────────────────────
 * A line can be short without anybody having decided to buy the difference —
 * the store may be waiting, or the requester may take what there is. `buyQty`
 * is the decision; the subtraction is merely arithmetic. Ordering against the
 * subtraction buys material on a decision no one made.
 */
function shortfallLines(mrf) {
  return (mrf.items || []).filter((i) => num(i.buyQty) > 0);
}

/**
 * The approved purchase request for this MRF.
 *
 * Found through the MRF's own forward link first. When that link points at a
 * request whose own `sourceMrfId` disagrees, the two records contradict each
 * other and neither can be trusted to say what was approved — so it is a
 * mismatch to reconcile, never a link to follow.
 */
async function loadRequest(tenant, mrf) {
  const scope = { ...tenantContext.tenantFilter(tenant) };
  let doc = null;

  if (mrf.spendRequestId) {
    doc = await SpendRequest.findOne({ _id: mrf.spendRequestId, ...scope }).lean();
    if (doc) {
      if (idOf(doc.sourceMrfId) !== idOf(mrf._id)) {
        throw fail("REQUEST_MRF_MISMATCH",
          `${doc.requestNumber || "The linked purchase request"} does not record ${mrf.mrfNumber} as its source. The two records disagree and must be reconciled before an order can be raised.`,
          { mrfNumber: mrf.mrfNumber, requestNumber: doc.requestNumber || "" });
      }
      /* The number is stored for historical readability; the id is identity.
         When they disagree, something rewrote one of them. */
      if (String(doc.sourceMrfNumber || "") !== String(mrf.mrfNumber || "")) {
        throw fail("REQUEST_MRF_MISMATCH",
          `${doc.requestNumber || "The linked purchase request"} records a different material request number (${doc.sourceMrfNumber || "none"}) from the one it points at (${mrf.mrfNumber}).`,
          { mrfNumber: mrf.mrfNumber, storedNumber: doc.sourceMrfNumber || "" });
      }
    }
  }

  /* No forward link, or it pointed outside this company: look for a request
     that claims this MRF as its source. */
  if (!doc) {
    doc = await SpendRequest.findOne({
      sourceMrfId: mrf._id, requestType: MATERIAL_REQUEST_TYPE, ...scope,
    }).sort({ createdAt: -1 }).lean();
  }

  /* A SERVICE request is not a material one. Services keep their own
     approved-service-request flow and never produce a purchase order. */
  if (doc && doc.requestType !== MATERIAL_REQUEST_TYPE) doc = null;

  if (!doc) {
    throw fail("MRF_NO_PURCHASE_REQUEST",
      `${mrf.mrfNumber} has material to buy but no approved purchase request yet. Raise the purchase request from the material request first — that is where sourcing and the budget are agreed.`,
      {
        mrfNumber: mrf.mrfNumber,
        correction: `/store/dashboard/order-requests/mrf/${idOf(mrf._id)}`,
        correctionLabel: "Open the material request",
      });
  }
  return doc;
}

/**
 * Finance's decision, as the existing workflow records it.
 *
 * ── EVERY APPROVAL IS AN APPROVAL ───────────────────────────────────────────
 * `budgetApprovalKind` distinguishes within-budget, over-budget and unbudgeted
 * spending. All three are decisions Finance MADE; the field exists so that
 * somebody can later ask how the year went over, not to mark two of them
 * invalid. Reading anything but `within_budget` as a refusal would block
 * exactly the spending Finance deliberately signed off.
 *
 * And its ABSENCE is not a refusal either: MRF budget involvement can be turned
 * off, in which case the request is created already approved and never carries
 * a decision at all. The authority is the request's STATUS.
 */
/**
 * Commitment states that still hold money for this request.
 *
 * `released` does not: the promise was given back, so an order raised against
 * it would be spending money that is no longer reserved. `unbudgeted` DOES —
 * it is the record of a deliberate Finance decision to approve without a
 * budget line, not an absence of one.
 */
const LIVE_COMMITMENT = Object.freeze(["committed", "unbudgeted", "partially_released"]);

/** The modes a request may have been raised under. */
const BUDGET_MODE = Object.freeze({
  COMMITMENT_REQUIRED: "COMMITMENT_REQUIRED",
  PAUSED: "BUDGET_PAUSED",
});

/**
 * Finance's authority to spend, proved rather than assumed.
 *
 * ── WHY ABSENCE IS NEVER THE ANSWER ─────────────────────────────────────────
 * A missing commitment has two opposite meanings: budget review was paused for
 * this request, or the commitment that should exist does not. Reading absence
 * as "paused" makes a deleted, corrupt or cross-company commitment look like a
 * deliberate policy — which is exactly the case that must be refused. So the
 * mode is read from the marker the server wrote when the request was raised,
 * and the commitment is then verified against it.
 *
 * ── AND WHY OVER-BUDGET IS STILL AN APPROVAL ────────────────────────────────
 * `budgetApprovalKind` distinguishes within-budget, over-budget and unbudgeted
 * spending. All three are decisions Finance MADE; the field exists so somebody
 * can later ask how the year went over, not to mark two of them invalid.
 */
async function budgetAuthority(tenant, request) {
  const base = {
    kind: request.budgetApprovalKind || null,
    mode: request.budgetApprovalMode || null,
    commitmentId: request.commitmentId || null,
    commitmentStatus: request.commitmentStatus || null,
  };

  /* At issue time the request may legitimately already read `ordered` — see
     the note in `assertIssuable`. Authority is about the money, and the money
     was approved either way; the STATUS rule is enforced there, once. */
  const spendable = request.status === ORDERABLE_STATUS || request.status === "ordered";
  if (!spendable) return { ...base, authorised: false, commitment: null };

  const refuse = (why, details = {}) => {
    throw fail("BUDGET_AUTHORITY_UNAVAILABLE",
      `${request.requestNumber || "This purchase request"} cannot be ordered against: ${why}`,
      {
        requestNumber: request.requestNumber || "",
        mode: base.mode, ...details,
        correction: `/store/dashboard/order-requests/quote/${idOf(request._id)}`,
        correctionLabel: "Open the purchase request",
      });
  };

  /* ── AN UNPROVEN MODE FAILS CLOSED ─────────────────────────────────────
     A request raised before the marker existed cannot prove which rules it was
     approved under. It is not refused outright — that would strand live,
     legitimately approved work — but it must still show a valid commitment,
     which is the stricter of the two readings. */
  const mode = base.mode || BUDGET_MODE.COMMITMENT_REQUIRED;

  if (mode === BUDGET_MODE.PAUSED) {
    /* Allowed to have no commitment — but ONLY because the server said so when
       the request was raised, never because the field happens to be empty. */
    return { ...base, mode, authorised: true, commitment: null, commitmentWaived: true };
  }

  if (!request.commitmentId) {
    refuse("Finance's budget commitment for it is missing. It must be reapproved before anything is ordered.",
      { reason: "COMMITMENT_MISSING" });
  }

  const commitment = await Acc_BudgetCommitment.findById(request.commitmentId)
    .select("_id status amount releasedAmount companyId spendRequestId allocations").lean();

  if (!commitment) {
    refuse("the budget commitment it refers to no longer exists.", { reason: "COMMITMENT_NOT_FOUND" });
  }
  /* Cross-company evidence is not evidence. */
  if (commitment.companyId && idOf(commitment.companyId) !== idOf(tenant.companyId)) {
    refuse("its budget commitment belongs to another company.", { reason: "COMMITMENT_FOREIGN_COMPANY" });
  }
  /* And it must be THIS request's promise, not one that happens to be valid. */
  if (idOf(commitment.spendRequestId) !== idOf(request._id)) {
    refuse("its budget commitment was made for a different request.", { reason: "COMMITMENT_MISMATCHED" });
  }
  if (!LIVE_COMMITMENT.includes(String(commitment.status))) {
    refuse(`its budget commitment is ${String(commitment.status || "in an unknown state")} and no longer holds the money.`,
      { reason: "COMMITMENT_NOT_LIVE", commitmentStatus: commitment.status || null });
  }
  /* A commitment with no company is not proof of anything: it cannot be shown
     to belong to this tenant at all. */
  if (!commitment.companyId) {
    refuse("its budget commitment records no company, so it cannot be shown to belong here.",
      { reason: "COMMITMENT_NO_COMPANY" });
  }

  return { ...base, mode, authorised: true, commitment, commitmentWaived: false };
}

/**
 * Does the promise still cover the money this order will commit?
 *
 * ── WHY EXISTENCE IS NOT ENOUGH ─────────────────────────────────────────────
 * A live commitment for ₹1 is not authority to issue a ₹100,000 order, and a
 * commitment that has been partly released no longer holds what it originally
 * did. `amount` is deliberately never rewritten by a release — it is the record
 * of what Finance agreed on a date — so what is still promised is
 * `amount - releasedAmount`, and that is the figure an order must fit inside.
 */
function assertCommitmentCovers(request, budget, totalAmount, poNumber) {
  if (!budget || budget.commitmentWaived || !budget.commitment) return;

  const c = budget.commitment;
  const promised = money(c.amount);
  const released = money(c.releasedAmount);
  const remaining = money(promised - released);

  if (money(totalAmount) > remaining + TOLERANCE) {
    throw fail("BUDGET_AUTHORITY_UNAVAILABLE",
      `${poNumber || "This order"} comes to ${money(totalAmount)}, but the budget commitment for `
      + `${request.requestNumber || "its purchase request"} still holds only ${remaining}`
      + `${released ? ` (${promised} approved, ${released} already released)` : ""}. `
      + "The purchase request must be revised and reapproved for the larger figure.",
      {
        requestNumber: request.requestNumber || "",
        reason: released ? "COMMITMENT_PARTLY_RELEASED" : "COMMITMENT_TOO_SMALL",
        orderTotal: money(totalAmount), committed: promised, released, remaining,
        correction: `/store/dashboard/order-requests/quote/${idOf(request._id)}`,
        correctionLabel: "Open the purchase request",
      });
  }

  /* ── AND WHERE THE PROMISE IS BROKEN DOWN BY LINE ──────────────────────
     Some commitments carry per-line `allocations`. Where they do, a total that
     fits overall can still be wrong line by line: ₹100 promised against line A
     does not authorise ₹100 spent on line B.

     Checked only where allocations exist — their ABSENCE is the model's own
     legacy signal (there is deliberately no schema default), and a commitment
     without them is one undivided promise the total check above covers.

     ── THE ARITHMETIC IS FINANCE'S, NOT THIS SERVICE'S ────────────────────
     `lineAllocation.allocateLines()` is the one place that splits an approved
     total across lines, header adjustment and last-line remainder included.
     This re-runs it over the approved request and compares each stored
     allocation with what it produces, so the two cannot drift. A second
     formula here would be a second answer to the same question, and the paise
     it disagreed by would surface at a year-end reconciliation with nobody
     able to say which was right. */
  const allocations = Array.isArray(c.allocations) ? c.allocations : [];
  if (!allocations.length) return;

  const expected = lineAllocation.allocateLines({
    lines: request.items || [],
    grandTotal: request.grandTotal,
  });
  if (!expected.ok) {
    throw fail("BUDGET_AUTHORITY_UNAVAILABLE",
      `The approved allocation for ${request.requestNumber || "this request"} cannot be reconstructed: ${expected.message}`,
      { requestNumber: request.requestNumber || "", reason: "ALLOCATION_UNREADABLE", allocatorCode: expected.code });
  }
  const expectedByLine = new Map(
    expected.allocations.filter((a) => a.spendLineId).map((a) => [String(a.spendLineId), a]),
  );

  /* One stored allocation per approved line. A duplicate is not a larger
     promise, it is two records of the same one. */
  const storedByLine = new Map();
  for (const a of allocations) {
    const key = idOf(a.spendLineId);
    if (!key) {
      throw fail("BUDGET_AUTHORITY_UNAVAILABLE",
        `${request.requestNumber || "This request"} has a budget allocation that names no line.`,
        { requestNumber: request.requestNumber || "", reason: "ALLOCATION_UNATTRIBUTED" });
    }
    if (storedByLine.has(key)) {
      throw fail("BUDGET_AUTHORITY_UNAVAILABLE",
        `${request.requestNumber || "This request"} has two budget allocations for the same line.`,
        { requestNumber: request.requestNumber || "", reason: "ALLOCATION_DUPLICATE" });
    }
    if (!expectedByLine.has(key)) {
      throw fail("BUDGET_AUTHORITY_UNAVAILABLE",
        `${request.requestNumber || "This request"} has a budget allocation for a line that is not on it.`,
        { requestNumber: request.requestNumber || "", reason: "ALLOCATION_UNKNOWN_LINE" });
    }
    storedByLine.set(key, a);
  }

  for (const l of request.items || []) {
    const key = idOf(l._id);
    const want = expectedByLine.get(key);
    const got = storedByLine.get(key);

    if (!got) {
      throw fail("BUDGET_AUTHORITY_UNAVAILABLE",
        `${l.name || "A line"} on ${request.requestNumber || "this request"} has no budget allocation, `
        + "so there is nothing promised against it.",
        { requestNumber: request.requestNumber || "", line: l.name || "", reason: "ALLOCATION_MISSING" });
    }
    if (!LIVE_COMMITMENT.includes(String(got.status))) {
      throw fail("BUDGET_AUTHORITY_UNAVAILABLE",
        `The budget allocation for ${l.name || "a line"} is ${String(got.status || "in an unknown state")} and no longer holds the money.`,
        { requestNumber: request.requestNumber || "", line: l.name || "", reason: "ALLOCATION_NOT_LIVE" });
    }

    /* ── `amount` IS ALREADY FINAL ────────────────────────────────────────
       The allocator returns `lineAmount` (the line before the header
       adjustment), `adjustment` (its apportioned share) and `amount`, which is
       the two added. Adding `adjustment` to `amount` therefore applies it
       TWICE: with freight it overstates the authority, and with a discount —
       where the adjustment is negative — it understates it and refuses a
       perfectly valid order. `amount` alone is what was committed. */
    if (!sameMoney(got.amount, want.amount)) {
      throw fail("BUDGET_AUTHORITY_UNAVAILABLE",
        `The budget allocation for ${l.name || "a line"} is ${money(got.amount)}, but the approved split for it is ${money(want.amount)}.`,
        {
          requestNumber: request.requestNumber || "", line: l.name || "",
          reason: "ALLOCATION_MISMATCH",
          stored: money(got.amount), expected: money(want.amount),
          lineAmount: want.lineAmount, adjustment: want.adjustment,
        });
    }

    /* What is still held. `remainingAmount` is stored and derived; where it is
       absent — an older row — it is `amount - releasedAmount`, the same figure
       by definition. */
    const remaining = usableNumber(got.remainingAmount)
      ? money(got.remainingAmount)
      : money(num(got.amount) - num(got.releasedAmount));

    if (remaining + TOLERANCE < money(want.amount)) {
      throw fail("BUDGET_AUTHORITY_UNAVAILABLE",
        `${l.name || "A line"} needs ${money(want.amount)} but its budget allocation still holds only ${remaining}`
        + `${num(got.releasedAmount) ? ` (${money(got.amount)} committed, ${money(got.releasedAmount)} released)` : ""}.`,
        {
          requestNumber: request.requestNumber || "", line: l.name || "",
          reason: num(got.releasedAmount) ? "ALLOCATION_PARTLY_RELEASED" : "ALLOCATION_TOO_SMALL",
          committed: money(got.amount), released: money(got.releasedAmount), remaining,
        });
    }
  }
}

/**
 * One supplier, by identity first.
 *
 * A display name is not identity — two suppliers can share a name — so distinct
 * suppliers are counted on the stored `vendorId`, and only lines carrying no id
 * fall back to a normalised name. Several ids IS several suppliers, never the
 * first of them.
 */
function supplierOf(request) {
  const lines = request.items || [];
  const ids = [...new Set(lines.map((l) => idOf(l.vendorId)).filter(Boolean))];
  const idlessNames = [...new Set(lines
    .filter((l) => !l.vendorId)
    .map((l) => String(l.vendorName || "").trim())
    .filter(Boolean)
    .map((n) => n.toLowerCase()))];

  if (ids.length + idlessNames.length > 1) {
    /* ── THE BYPASS THIS REFUSAL CLOSES ────────────────────────────────────
       The old message sent the buyer to "the purchase-order module" to raise
       it directly — an unlinked order with no MRF, no approval and no budget,
       which is exactly what this chunk exists to prevent. The answer is
       upstream: one approved request per supplier. */
    throw fail("SUPPLIER_SPLIT_REQUIRED",
      `${request.requestNumber || "This purchase request"} names ${ids.length + idlessNames.length} suppliers. A purchase order goes to one supplier, so the request must be split into one approved request per supplier before ordering — splitting it here would order against a budget decision nobody made for that supplier.`,
      {
        requestNumber: request.requestNumber || "",
        supplierCount: ids.length + idlessNames.length,
        correction: `/store/dashboard/order-requests/quote/${idOf(request._id)}`,
        correctionLabel: "Open the purchase request to split it",
      });
  }

  const name = lines.map((l) => String(l.vendorName || "").trim()).find(Boolean)
    || String(request.vendorName || "").trim();
  return { vendorId: ids[0] || null, vendorName: name };
}

/**
 * How much of each approved line an existing order has already taken.
 *
 * ── ONE SERVER RULE, NOT A COUNT PER SCREEN ─────────────────────────────────
 * Every caller asks this the same way, so "already ordered" cannot mean two
 * things in two places. Cancelled orders are excluded: they bought nothing.
 */
async function orderedQuantities(tenant, request) {
  const orders = await PurchaseOrder.find({
    spendRequestId: request._id,
    status: { $in: CONSUMES_QUANTITY },
    ...tenantContext.tenantFilter(tenant),
  }).select("poNumber status items.spendLineId items.quantity").lean();

  const byLine = new Map();
  for (const po of orders) {
    for (const line of po.items || []) {
      const key = idOf(line.spendLineId);
      if (!key) continue;
      byLine.set(key, num(byLine.get(key)) + num(line.quantity));
    }
  }
  return { byLine, orders };
}

/**
 * Resolve the whole chain, or refuse with a reason a buyer can act on.
 *
 * Returns the authoritative records and the lines an order may be raised for.
 * Nothing in the returned shape came from the caller's body.
 */
/**
 * The half of the rules that are about the APPROVAL, not about the need.
 *
 * ── WHY THIS IS ITS OWN FUNCTION ────────────────────────────────────────────
 * A material purchase order must prove an operational need. A material request
 * is the ONLY proof of that. An intake requirement is a real operational need,
 * but it is not a material request, and an earlier pass that accepted one on
 * its own opened a second door into this invariant — see `resolveForRequest`.
 *
 * Everything below here is identical for both, so it lives in one place: the
 * approval gate, the supplier rule, the line derivation, the already-ordered
 * arithmetic and the totals. Only the proof of need differs, and that is what
 * the two callers supply.
 */
async function resolveApproved(tenant, request, body = {}, mrf = null) {
  if (request.status !== ORDERABLE_STATUS) {
    throw fail("REQUEST_NOT_APPROVED",
      `${request.requestNumber || "That purchase request"} is ${request.status.replace(/_/g, " ")}, so nothing can be ordered against it yet. A purchase order may only be raised once Finance has approved the request.`,
      {
        requestNumber: request.requestNumber || "",
        status: request.status,
        correction: `/store/dashboard/order-requests/quote/${idOf(request._id)}`,
        correctionLabel: "Open the purchase request",
      });
  }

  const budget = await budgetAuthority(tenant, request);
  if (!budget.authorised) {
    throw fail("BUDGET_AUTHORITY_UNAVAILABLE",
      `${request.requestNumber || "That purchase request"} carries no valid approval to spend against.`,
      { requestNumber: request.requestNumber || "" });
  }

  const supplier = supplierOf(request);

  const approvedLines = request.items || [];
  if (!approvedLines.length) {
    throw fail("LINE_NOT_APPROVED",
      `${request.requestNumber || "That purchase request"} has no approved lines to order.`,
      { requestNumber: request.requestNumber || "" });
  }

  /* ── EVERY APPROVED LINE IS ONE MATERIAL-REQUEST LINE ─────────────────────
     Proving the MRF has *something* to buy is not enough. A request linked to
     an MRF could carry material B while the MRF's only shortfall is material
     A, and the order would look perfectly governed.

     So each approved line names the MRF line it is buying, by id, and that
     mapping must be a bijection into the MRF's buy lines: no unknown line, no
     line used twice, and a quantity that fits the shortfall that was actually
     decided. Identity is checked on the ids — never on a name two catalogue
     items can share, never on an array position a reorder changes. */
  const mrfBuyLines = mrf ? shortfallLines(mrf) : [];
  const mrfById = new Map(mrfBuyLines.map((l) => [idOf(l._id), l]));
  const claimed = new Map();

  approvedLines.forEach((l) => {
    const key = idOf(l.sourceMrfLineId);
    if (!key) {
      /* Fails closed. An approved line with no stated origin cannot be proved
         to come from this material request, and "we cannot tell" must never
         read as "it is fine". */
      throw fail("LINE_NOT_APPROVED",
        `${l.name || "A line"} on ${request.requestNumber || "this request"} does not say which material-request line it is buying, so it cannot be proved to come from ${mrf ? mrf.mrfNumber : "a material request"}. Raise the purchase request again from the material request.`,
        { requestNumber: request.requestNumber || "", line: l.name || "", reason: "LINE_PROVENANCE_MISSING" });
    }
    const mrfLine = mrfById.get(key);
    if (!mrfLine) {
      throw fail("LINE_NOT_APPROVED",
        `${l.name || "A line"} is not one of the lines ${mrf ? mrf.mrfNumber : "the material request"} decided to buy.`,
        { requestNumber: request.requestNumber || "", line: l.name || "", reason: "LINE_NOT_IN_MRF" });
    }
    if (claimed.has(key)) {
      throw fail("LINE_NOT_APPROVED",
        `Two lines on ${request.requestNumber || "this request"} claim the same material-request line (${mrfLine.rawItemName || "one item"}).`,
        { requestNumber: request.requestNumber || "", reason: "LINE_CLAIMED_TWICE" });
    }
    claimed.set(key, l);

    /* The material itself, not merely the line it points at. */
    if (mrfLine.rawItem && idOf(l.rawItem) !== idOf(mrfLine.rawItem)) {
      throw fail("LINE_NOT_APPROVED",
        `${l.name || "A line"} is not the material ${mrfLine.rawItemName || "the material request"} asked for.`,
        { requestNumber: request.requestNumber || "", reason: "LINE_MATERIAL_MISMATCH" });
    }
    if (idOf(l.variantId || null) !== idOf(mrfLine.variantId || null)) {
      throw fail("LINE_NOT_APPROVED",
        `${l.name || "A line"} is a different variant from the one requested.`,
        { requestNumber: request.requestNumber || "", reason: "LINE_VARIANT_MISMATCH" });
    }
    /* Units must agree, or a quantity comparison is meaningless: 10 metres is
       not 10 rolls, and comparing the numbers alone would pass. */
    if (String(l.unit || "").trim().toLowerCase()
        !== String(mrfLine.unit || "").trim().toLowerCase()) {
      throw fail("LINE_NOT_APPROVED",
        `${l.name || "A line"} is priced in ${l.unit || "no unit"} but requested in ${mrfLine.unit || "no unit"}. Converting it is a decision for the purchase request, not the order.`,
        { requestNumber: request.requestNumber || "", reason: "LINE_UNIT_MISMATCH" });
    }
    /* And no more than the shortfall the store actually decided to buy. */
    if (num(l.quantity) > num(mrfLine.buyQty) + TOLERANCE) {
      throw fail("QUANTITY_EXCEEDS_APPROVED",
        `${l.name || "A line"} is for ${num(l.quantity)} ${l.unit || ""}`.trimEnd()
        + `, but ${mrf ? mrf.mrfNumber : "the material request"} decided to buy only ${num(mrfLine.buyQty)}.`,
        {
          requestNumber: request.requestNumber || "", line: l.name || "",
          requested: num(l.quantity), mrfBuyQty: num(mrfLine.buyQty), reason: "EXCEEDS_MRF_BUY_QTY",
        });
    }
  });

  const { byLine, orders } = await orderedQuantities(tenant, request);

  /* ── THE CALLER ASKS FOR NOTHING ─────────────────────────────────────────
     Every line, at its FULL approved quantity. An earlier pass accepted a
     `requestedLines` array so a buyer could order less, and mapped it onto the
     approved lines BY INDEX — two mistakes at once.

     The index map was the smaller one: reorder the array and line 1's quantity
     lands on line 2's material. The real problem is that one approved request
     converts to at most one order (the partial unique index on
     `spendRequestId`), so ordering less does not leave the rest for later — it
     strands it permanently behind a request that can never be ordered again.
     A buyer would see the shortfall satisfied and the material never arrive.

     Partial and split ordering is a genuine need and a separate product
     decision: it requires a per-line ordered quantity on the request, a
     relaxation of that index, and an answer to how the commitment is
     discharged in parts. Until that exists, the honest behaviour is all or
     nothing. */
  if (body.requestedLines !== undefined) {
    throw fail("QUANTITY_EXCEEDS_APPROVED",
      "A purchase order covers the whole approved purchase request. To order part of it, "
      + "the request must be split and reapproved — ordering less here would strand the "
      + "remainder behind a request that cannot be ordered again.",
      { requestNumber: request.requestNumber || "", field: "requestedLines" });
  }
  /* Nor may a caller drop lines or slip extra ones in: the set is the approved
     set. Checked explicitly because an empty `items` array reads as "no
     opinion" and would otherwise pass unnoticed. */
  if (Array.isArray(body.items) && body.items.length
      && body.items.length !== approvedLines.length) {
    throw fail("LINE_NOT_APPROVED",
      `This purchase request has ${approvedLines.length} approved line${approvedLines.length === 1 ? "" : "s"} `
      + `and every one of them is ordered together. ${body.items.length} were supplied.`,
      {
        requestNumber: request.requestNumber || "",
        approvedLineCount: approvedLines.length,
        suppliedLineCount: body.items.length,
      });
  }

  const lines = [];
  approvedLines.forEach((l) => {
    const approvedQty = num(l.quantity);
    const already = num(byLine.get(idOf(l._id)));
    const remaining = Math.max(0, approvedQty - already);

    /* The full approved quantity, always. */
    const wanted = approvedQty;

    if (already > 0) {
      throw fail("QUANTITY_ALREADY_ORDERED",
        `${l.name || "A line"} on ${request.requestNumber || "this request"} is already on order`
        + `${remaining ? `, leaving ${remaining} ${l.unit || ""} unordered`.trimEnd() : ""}`
        + ". An approved request converts to one purchase order; to buy more, revise and reapprove it.",
        {
          requestNumber: request.requestNumber || "",
          line: l.name || "", approvedQuantity: approvedQty, alreadyOrdered: already, remaining,
        });
    }

    const unitPrice = money(l.rate);
    const net = money(wanted * unitPrice);
    const gstRate = num(l.gstPercent);
    /* The approved tax figure where Finance recorded one — the derived
       percentage only where they did not. */
    const gstAmount = typeof l.taxAmount === "number"
      ? money(l.taxAmount)
      : money((net * gstRate) / 100);

    lines.push({
      /* The approved line this order line discharges. Without it a supplier
         bill cannot say which budget allocation it settles, and billing one
         line of a four-line request releases the whole commitment. */
      spendLineId: l._id,
      /* And the material-request line behind it, so the chain is provable at
         line level from the order alone. */
      sourceMrfLineId: l.sourceMrfLineId || null,
      variantId: l.variantId || null,
      rawItem: l.rawItem || null,
      itemName: l.name || "",
      sku: l.rawItemSku || "",
      unit: l.unit || "unit",
      baseUnit: l.baseUnit || "",
      quantity: wanted,
      unitPrice,
      totalPrice: net,
      gstRate,
      gstAmount,
      quoteRef: l.quoteRef || "",
      approvedQuantity: approvedQty,
      alreadyOrdered: already,
      remainingQuantity: remaining,
      expectedDeliveryDate: l.expectedDeliveryDate || request.expectedDeliveryDate || null,
    });
  });

  const orderable = lines.filter((l) => l.quantity > 0);
  if (!orderable.length) {
    throw fail("QUANTITY_ALREADY_ORDERED",
      `Everything approved on ${request.requestNumber || "this request"} is already on order`
      + `${orders.length ? ` (${orders.map((o) => o.poNumber).filter(Boolean).join(", ")})` : ""}`
      + ". To buy more, the purchase request must be revised and reapproved.",
      {
        requestNumber: request.requestNumber || "",
        existingOrders: orders.map((o) => o.poNumber).filter(Boolean),
      });
  }

  /* ── CHARGES ARE COMMERCIAL, AND THEY HAVE AN APPROVED HOME ──────────────
     Shipping, a discount and any other charge read like delivery arrangements
     and are not: each moves what the company will owe against a budget somebody
     approved for a different figure.

     They are not forbidden — that would remove a feature people use. They are
     approved on the PURCHASE REQUEST, where Finance sees the grand total they
     are agreeing to, and the order carries them forward read-only. A buyer who
     needs freight adds it there and has it reapproved.

     A value sent here is compared with the approved one rather than ignored: a
     client that sends a charge believes it is adding one, and silently
     dropping it would leave somebody certain they had recorded a cost they had
     not. Negative and malformed values are refused for the same reason — they
     are not "no charge", they are a value nobody can act on. */
  const approvedShipping = money(request.approvedShippingCharges);
  const approvedDiscount = money(request.approvedDiscount);
  const approvedCustom = (request.approvedCustomCharges || [])
    .filter((c) => c && String(c.label || "").trim())
    .map((c) => ({ label: String(c.label).trim(), amount: money(c.amount) }));
  const approvedCustomTotal = money(approvedCustom.reduce((t, c) => t + c.amount, 0));

  /* ── THE APPROVED TOTAL MUST STILL FOLLOW FROM ITS OWN PARTS ────────────
     `grandTotal` is stored, and a stored derived figure can go stale: a line
     edited by a path that forgot to recompute, a partial write, a migration.
     It is what the budget commitment was made for and what `allocateLines`
     splits, so trusting it silently means ordering against a number nobody can
     reproduce. Checked rather than recomputed — quietly substituting a
     different total would hide exactly the inconsistency worth knowing. */
  const reconciliation = spendAdjustments.reconciles(request, TOLERANCE);
  if (!reconciliation.ok) {
    throw fail("BUDGET_AUTHORITY_UNAVAILABLE",
      `${request.requestNumber || "This purchase request"} records an approved total of `
      + `${reconciliation.stored}, but its lines and approved charges come to `
      + `${reconciliation.expected}. It must be requoted and reapproved before anything is ordered `
      + "against it.",
      {
        requestNumber: request.requestNumber || "", reason: "GRAND_TOTAL_STALE",
        storedGrandTotal: reconciliation.stored, reconstructed: reconciliation.expected,
        breakdown: reconciliation.breakdown,
        correction: `/store/dashboard/order-requests/quote/${idOf(request._id)}`,
        correctionLabel: "Open the purchase request",
      });
  }

  const adjustmentRefusal = (what, sent, approved) => fail("CHARGES_EXCEED_APPROVED",
    `${what} on this order would be ${sent}, but ${request.requestNumber || "the purchase request"} `
    + `approved ${approved}. Charges and discounts change what the order commits, so they are set on `
    + "the purchase request — revise and reapprove it to change one.",
    {
      requestNumber: request.requestNumber || "", field: what, sent, approved,
      correction: `/store/dashboard/order-requests/quote/${idOf(request._id)}`,
      correctionLabel: "Open the purchase request",
    });

  if (body.shippingCharges !== undefined) {
    const sent = Number(body.shippingCharges);
    if (!Number.isFinite(sent) || sent < 0) {
      throw adjustmentRefusal("Shipping", String(body.shippingCharges), approvedShipping);
    }
    if (!sameMoney(sent, approvedShipping)) throw adjustmentRefusal("Shipping", money(sent), approvedShipping);
  }
  if (body.discount !== undefined) {
    const sent = Number(body.discount);
    if (!Number.isFinite(sent) || sent < 0) {
      throw adjustmentRefusal("Discount", String(body.discount), approvedDiscount);
    }
    if (!sameMoney(sent, approvedDiscount)) throw adjustmentRefusal("Discount", money(sent), approvedDiscount);
  }
  if (body.customCharges !== undefined) {
    if (!Array.isArray(body.customCharges)) {
      throw adjustmentRefusal("Other charges", "not a list", approvedCustomTotal);
    }
    const sent = body.customCharges.filter((c) => c && String(c.label || "").trim());
    if (sent.some((c) => !Number.isFinite(Number(c.amount)) || Number(c.amount) < 0)) {
      throw adjustmentRefusal("Other charges", "a negative or unreadable amount", approvedCustomTotal);
    }
    /* Compared as a multiset of label+amount, so the same count and the same
       total do not pass when the charges themselves differ. */
    if (!sameCharges(sent, approvedCustom)) {
      throw fail("CHARGES_EXCEED_APPROVED",
        `The charges on this order are not the ones ${request.requestNumber || "the purchase request"} approved. `
        + `Approved: ${approvedCustom.map((c) => `${c.label} ${c.amount}`).join(", ") || "none"}. `
        + "Charges are set on the purchase request — revise and reapprove it to change one.",
        {
          requestNumber: request.requestNumber || "", field: "Other charges",
          approved: approvedCustom.map((c) => ({ label: c.label, amount: c.amount })),
          sent: sent.map((c) => ({ label: String(c.label).trim(), amount: money(c.amount) })),
          correction: `/store/dashboard/order-requests/quote/${idOf(request._id)}`,
          correctionLabel: "Open the purchase request",
        });
    }
  }

  const subtotal = money(orderable.reduce((t, l) => t + l.totalPrice, 0));
  const taxAmount = money(orderable.reduce((t, l) => t + l.gstAmount, 0));

  /* A single header rate only where every line shares one. Where they differ,
     no one number is the order's rate, and printing one restates the approval. */
  const distinctRates = [...new Set(orderable.map((l) => l.gstRate))];
  const taxMode = distinctRates.length <= 1 ? "SINGLE_RATE" : "MIXED_RATE";

  /* The promise has to cover the figure, not merely exist. */
  assertCommitmentCovers(request, budget,
    money(subtotal + taxAmount + approvedShipping + approvedCustomTotal - approvedDiscount), null);

  /* The supplier, only if it really belongs to this company. A vendor of the
     same id in another company is never attached. */
  let vendorId = null;
  if (supplier.vendorId) {
    /* ── AN EXPLICIT SUPPLIER IS AN ANSWER, NOT A HINT ────────────────────
       Where the approved request names a supplier BY ID, that is the supplier
       Finance approved. If it cannot be found, or belongs to another company,
       the old code fell through to a name lookup and attached whichever
       supplier happened to share the name — quietly sending the order to a
       different company's vendor, or to a namesake of the one approved.
       Refused instead: a supplier that cannot be verified is not a supplier. */
    const v = await Vendor.findOne({ _id: supplier.vendorId, companyId: tenant.companyId })
      .select("_id companyName").lean().catch(() => null);
    if (!v) {
      throw fail("SUPPLIER_SPLIT_REQUIRED",
        `The supplier approved on ${request.requestNumber || "this purchase request"} is not available to `
        + "this company, so the order cannot be raised against it. Reapprove the request with a supplier "
        + "on this company's supplier master.",
        {
          requestNumber: request.requestNumber || "", reason: "SUPPLIER_UNAVAILABLE",
          correction: `/store/dashboard/order-requests/quote/${idOf(request._id)}`,
          correctionLabel: "Open the purchase request",
        });
    }
    vendorId = v._id;
  } else if (supplier.vendorName) {
    /* Name matching only where the approval genuinely named no id — a
       name-only supplier is fully supported, and is all there is to go on. */
    const v = await Vendor.findOne({ companyName: supplier.vendorName, companyId: tenant.companyId })
      .select("_id").lean().catch(() => null);
    if (v) vendorId = v._id;
  }

  return {
    companyId: tenant.companyId,
    mrf,
    spendRequest: request,
    budget,
    vendorId,
    vendorName: supplier.vendorName,
    lines: orderable,
    totals: {
      subtotal,
      taxAmount,
      taxMode,
      headerTaxRate: taxMode === "SINGLE_RATE" ? (distinctRates[0] || 0) : 0,
      /* The adjustments Finance approved, carried onto the order. */
      shippingCharges: approvedShipping,
      discount: approvedDiscount,
      customCharges: approvedCustom,
      customChargesTotal: approvedCustomTotal,
      /* The figure the company will owe — the one the approver saw. */
      totalAmount: money(subtotal + taxAmount + approvedShipping + approvedCustomTotal - approvedDiscount),
    },
    /* ── IMMUTABLE, SERVER-OWNED PROVENANCE ────────────────────────────────
       Ids are identity; the numbers are stored beside them for historical
       readability, so a register printed years later still reads sensibly
       even if a document is renumbered. */
    provenance: {
      /* Always present on a governed order: `resolveChain` and
         `resolveForRequest` both require a material request before reaching
         here. The guard remains so a future caller cannot produce an order
         with no source by passing none. */
      sourceMrfId: mrf ? mrf._id : null,
      sourceMrfNumber: mrf ? mrf.mrfNumber : "",
      sourceMrfDepartment: mrf ? (mrf.requestedForDept || "") : (request.department || ""),
      spendRequestId: request._id,
      spendRequestNumber: request.requestNumber || "",
      budgetApprovalKind: budget.kind,
      commitmentId: budget.commitmentId,
    },
  };
}

/**
 * The material-request route into an order: the rule the New purchase order
 * form enforces on every material purchase, without exception.
 */
/**
 * An order from the form's own supplier and lines, with no material request.
 *
 * Only while the material-request rule is off (see MRF_RULE_ON). The figures
 * are computed exactly as the create route computes each line — quantity ×
 * rate, item charges (amount or percent of the line), GST per line — so the
 * header totals agree with the lines the route stores. Nothing is reloaded
 * from an approval because there is none; that is what the AD_HOC stamp says.
 */
function resolveAdHoc(body = {}) {
  const lines = (Array.isArray(body.items) ? body.items : []).filter((i) => i && i.rawItem);
  if (!lines.length) {
    throw fail("VALIDATION", "Add at least one material line to the order.", { field: "items" });
  }
  if (!body.vendor || !mongoose.isValidObjectId(String(body.vendor))) {
    throw fail("VALIDATION", "Choose the supplier this order goes to.", { field: "vendor" });
  }
  let subtotal = 0;
  let taxAmount = 0;
  const rates = new Set();
  for (const l of lines) {
    const qty = Number(l.quantity) || 0;
    const price = Number(l.unitPrice) || 0;
    const base = qty * price;
    const charges = (l.itemCharges || []).filter((c) => c && String(c.label || "").trim() && parseFloat(c.value) > 0)
      .reduce((s, c) => s + (c.type === "percent" ? (base * (parseFloat(c.value) || 0)) / 100 : (parseFloat(c.value) || 0)), 0);
    const lineTotal = base + charges;
    const rate = Number(l.gstRate) || 0;
    rates.add(rate);
    subtotal += lineTotal;
    taxAmount += (lineTotal * rate) / 100;
  }
  const shipping = money(body.shippingCharges);
  const discount = money(body.discount);
  const customCharges = (Array.isArray(body.customCharges) ? body.customCharges : [])
    .filter((c) => c && String(c.label || "").trim())
    .map((c) => ({ label: String(c.label).trim(), amount: money(c.amount) }));
  const customTotal = customCharges.reduce((s, c) => s + c.amount, 0);
  const distinct = [...rates];
  return {
    adHoc: true,
    vendorId: String(body.vendor),
    vendorName: String(body.vendorName || ""),
    lines,
    totals: {
      subtotal: money(subtotal),
      taxAmount: money(taxAmount),
      headerTaxRate: distinct.length === 1 ? distinct[0] : 0,
      shippingCharges: shipping,
      discount,
      customCharges,
      customChargesTotal: money(customTotal),
      totalAmount: money(subtotal + taxAmount + shipping + customTotal - discount),
    },
    provenance: null,
  };
}

async function resolveChain(tenant, body = {}) {
  if (!idOf(body.sourceMrfId) && !MRF_RULE_ON()) return resolveAdHoc(body);
  const mrf = await loadMrf(tenant, body.sourceMrfId);

  const shortfall = shortfallLines(mrf);
  if (!shortfall.length) {
    throw fail("MRF_NO_PURCHASE_SHORTFALL",
      `${mrf.mrfNumber} has nothing to buy — every line was issued from stock or is still being decided. A purchase order needs a line the store decided to purchase.`,
      { mrfNumber: mrf.mrfNumber });
  }

  const request = await loadRequest(tenant, mrf);
  return resolveApproved(tenant, request, body, mrf);
}

/**
 * The route taken by the contextual "Create purchase order" action on an
 * approved request.
 *
 * ── THE SAME RULE AS THE FORM'S ─────────────────────────────────────────────
 * It requires a material request, exactly as `resolveChain` does. The only
 * difference is where the request comes from: the form is handed an MRF and
 * finds the approval, this is handed the approval and finds the MRF.
 */
async function resolveForRequest(tenant, request, body = {}) {
  /* ── ONE PROOF OF NEED, AND IT IS THE MATERIAL REQUEST ────────────────────
     An earlier pass let an intake-origin request through on `intakeRequestId`
     alone, to avoid taking a live journey offline. That was a second door into
     the same invariant, and a door is exactly what this rule cannot have: the
     weaker entry point becomes the way round the rule for everyone.

     It was also a dead end in practice. Such an order was created with
     `sourceMrfId: null`, and `assertIssuable` requires a material request —
     so the draft could be raised and never issued. Refusing at creation is
     both the rule and the kinder answer.

     Intake is not being removed: an intake requirement must be linked to, or
     converted into, a material request before it can be ordered. That
     conversion is deliberately NOT automated here. */
  if (!request.sourceMrfId) {
    const viaIntake = Boolean(request.intakeRequestId);
    throw fail("MRF_REQUIRED",
      viaIntake
        ? `${request.requestNumber || "This request"} came from an intake requirement and has no material request. Link it to a material request — or raise one for it — before ordering: a purchase order has to say which material request it fulfils.`
        : `${request.requestNumber || "This request"} records no material request, so there is nothing to say why the material is needed. Raise it from a material request.`,
      {
        requestNumber: request.requestNumber || "",
        origin: viaIntake ? "intake" : "none",
        ...(viaIntake ? {
          intakeRequestId: idOf(request.intakeRequestId),
          correction: `/store/dashboard/order-requests/intake/${idOf(request.intakeRequestId)}`,
          correctionLabel: "Open the intake requirement",
        } : {}),
      });
  }

  const mrf = await loadMrf(tenant, request.sourceMrfId);
  const linked = await loadRequest(tenant, mrf);
  if (idOf(linked._id) !== idOf(request._id)) {
    throw fail("REQUEST_MRF_MISMATCH",
      `${request.requestNumber || "This request"} and ${mrf.mrfNumber} do not agree about their link.`,
      { requestNumber: request.requestNumber || "", mrfNumber: mrf.mrfNumber });
  }

  const shortfall = shortfallLines(mrf);
  if (!shortfall.length) {
    throw fail("MRF_NO_PURCHASE_SHORTFALL",
      `${mrf.mrfNumber} has nothing left to buy, so nothing can be ordered against it.`,
      { mrfNumber: mrf.mrfNumber });
  }

  return resolveApproved(tenant, request, body, mrf);
}

/* ══════════════════════════════════════════════════════════════════════════
 * THE CUTOVER, AND WHAT COUNTS AS HISTORICAL
 * ═════════════════════════════════════════════════════════════════════════ */

/**
 * The rules stamp written on every order raised through the governed chain.
 * Versioned, so a later rule change can be told apart from this one.
 */
const PROVENANCE_POLICY = "MRF_REQUIRED_V1";
/* ── THE MATERIAL-REQUEST RULE IS OFF UNLESS ASKED FOR (30 Sep 2026) ────────
   The owner has asked, more than once, for the Store's gates to go: an order
   raised on the purchase-order form with no material request behind it was
   created fine and then refused at issue ("carries no purchasing provenance
   ... cannot be issued"), which is a form that lets you write what it will not
   let you send. While STORE_PURCHASE_REQUIRE_MRF is unset:
     · the form may create an order from its own supplier and lines
       (`resolveAdHoc`), stamped AD_HOC_NO_MRF_V1, and
     · an order with no stamp at all — the drafts raised before the rule that
       the legacy migration never reached — issues as a historical order does.
   STORE_PURCHASE_REQUIRE_MRF=1 brings the whole rule back, unchanged. */
const MRF_RULE_ON = () => process.env.STORE_PURCHASE_REQUIRE_MRF === "1";
const AD_HOC_POLICY = "AD_HOC_NO_MRF_V1";

/**
 * The marker a controlled migration writes onto orders that predate the rule.
 *
 * ── WHY A MARKER AND NOT A DATE ─────────────────────────────────────────────
 * The first version classified an order as historical when it had no policy and
 * `createdAt` was before a hard-coded instant. That fails OPEN in the one case
 * that matters: an order with a missing, unparseable or absent `createdAt` —
 * from a bulk insert, a restored backup, a bad migration — was treated as
 * historical and inherited every allowance. "We could not read its date" is not
 * evidence that it predates the rule.
 *
 * So historical status is now something a record CARRIES, written deliberately
 * by `scripts/migrations/stamp-legacy-purchase-orders.js`, which stamps exactly
 * the orders that existed when the rule came in and nothing else. Every order
 * is then in one of three states, and only the first two may act:
 *
 *   stamped LEGACY_PRE_MRF_V1  historical, migrated, keeps its old rules
 *   stamped MRF_REQUIRED_V1    governed, carries its full chain
 *   unstamped                  unproven — fails closed
 */
const LEGACY_POLICY = "LEGACY_PRE_MRF_V1";

/**
 * The instant the rule took effect.
 *
 * Retained only so the migration can select which orders to stamp, and so an
 * operator can audit what it did. It is NOT consulted when deciding whether an
 * order may act — that decision reads the marker alone.
 */
const PROVENANCE_CUTOVER = new Date("2026-09-28T00:00:00.000Z");

/**
 * Is this order one the rule does not reach?
 *
 * Only a stamped one. An unstamped order is not "probably old": it is
 * unproven, and an unproven order is refused rather than excused — otherwise
 * any row inserted without provenance inherits the historical allowances for
 * ever, which is the loophole this whole mechanism exists to close.
 */
function isLegacyOrder(po) {
  return Boolean(po && po.provenancePolicy === LEGACY_POLICY);
}

/**
 * Why an order may not act, in words, when it is neither governed nor migrated.
 */
function unprovenReason(po) {
  return `${po?.poNumber || "This order"} carries no purchasing provenance and has not been `
    + "migrated as a historical order, so there is no record of the rules it was raised under. "
    + "It cannot be issued. Raise it again from its material request, or have it included in the "
    + "legacy migration if it genuinely predates the material-request rule.";
}

/**
 * The provenance policies this code actually understands.
 *
 * ── WHY A LIST AND NOT "ANY NON-EMPTY VALUE" ────────────────────────────────
 * Accepting any string means a typo, a half-finished migration or a future
 * policy this code has never seen all read as "governed", and the order is
 * validated by rules that were written for something else. A policy names the
 * rules a record was created under; if this code cannot name them, it cannot
 * check them, and it must say so instead of guessing.
 */
const SUPPORTED_POLICIES = Object.freeze([PROVENANCE_POLICY, LEGACY_POLICY, AD_HOC_POLICY]);
const isAdHocOrder = (po) => Boolean(po && po.provenancePolicy === AD_HOC_POLICY);
const isSupportedPolicy = (p) => SUPPORTED_POLICIES.includes(String(p || ""));

/** A governed order: raised under THIS rule, and carrying its proof. */
const isGovernedOrder = (po) => Boolean(po && po.provenancePolicy === PROVENANCE_POLICY);

/**
 * The fields a governed order carries so its chain can be re-proved later.
 *
 * Built from the resolved chain only — every value here was reloaded from a
 * stored record inside `resolveChain`.
 */
function provenanceFields(chain) {
  if (chain?.adHoc) return { provenancePolicy: AD_HOC_POLICY };
  return {
    provenancePolicy: PROVENANCE_POLICY,
    sourceMrfId: chain.provenance.sourceMrfId,
    sourceMrfNumber: chain.provenance.sourceMrfNumber,
    sourceMrfDepartment: chain.provenance.sourceMrfDepartment,
    spendRequestId: chain.provenance.spendRequestId,
    spendRequestNumber: chain.provenance.spendRequestNumber,
  };
}

/**
 * Re-prove a saved order's chain, at issue time.
 *
 * ── WHY CREATION-TIME VALIDATION IS NOT ENOUGH ──────────────────────────────
 * A draft sits between creation and issue, and both ends can move while it
 * does: the draft can be edited, and the approval it rests on can be revised,
 * rejected or already spent by another order. Issuing is the moment a supplier
 * is actually committed, so the chain is proved again there — against the
 * records as they stand, not as they stood.
 *
 * Refusals here change nothing: no status, no timestamps, no history, no
 * supplier email, no budget movement.
 */
async function assertIssuable(tenant, po) {
  /* A policy this code has never seen is not a weaker case of a known one —
     it is a record whose rules cannot be checked at all. */
  if (po.provenancePolicy && !isSupportedPolicy(po.provenancePolicy)) {
    throw fail("PROVENANCE_CHANGED",
      `${po.poNumber || "This order"} was raised under provenance rules this system does not support `
      + `("${po.provenancePolicy}"), so its chain cannot be checked. It cannot be issued until the `
      + "rules it names are supported.",
      { poNumber: po.poNumber || "", reason: "PROVENANCE_UNSUPPORTED", provenancePolicy: po.provenancePolicy });
  }

  /* Historical orders keep the rules they were raised under — but only if a
     migration said so. */
  if (isLegacyOrder(po)) return { governed: false, legacy: true };
  if (isAdHocOrder(po)) return { governed: false, adHoc: true };
  if (!isGovernedOrder(po) && !MRF_RULE_ON()) {
    /* Unstamped, and the rule is off: issued as a historical order is. */
    return { governed: false, legacy: true, unproven: true };
  }
  if (!isGovernedOrder(po)) {
    /* Neither governed nor migrated: unproven, and unproven fails closed. */
    throw fail("PROVENANCE_CHANGED", unprovenReason(po), {
      poNumber: po.poNumber || "",
      reason: "PROVENANCE_UNPROVEN",
      provenancePolicy: po.provenancePolicy || null,
    });
  }

  const sameCompany = idOf(po.companyId) === idOf(tenant.companyId);
  if (!sameCompany) {
    throw fail("PROVENANCE_CHANGED",
      "This order belongs to another company and cannot be issued from here.",
      { poNumber: po.poNumber || "" });
  }

  /* Reloaded, never taken from the order's own stored copies: the point is to
     find out whether the upstream records still say what the order claims. */
  const mrf = await MRF.findOne({ _id: po.sourceMrfId, ...tenantContext.tenantFilter(tenant) })
    /* `items._id` explicitly: the line id is what every check below matches on,
       and a sub-field projection that omits it leaves every comparison failing
       against `undefined` — which reads as "the material request no longer
       wants this", the most alarming possible way to be wrong. */
    .select("_id mrfNumber companyId items._id items.rawItem items.rawItemName "
      + "items.buyQty items.unit items.variantId").lean();
  const request = await SpendRequest.findOne({
    _id: po.spendRequestId, ...tenantContext.tenantFilter(tenant),
    /* Every field the checks below read. A projection that omits one does not
       fail loudly — it reads as zero or empty, and the comparison then refuses
       a perfectly good order for "not matching" a figure that was simply never
       fetched. */
  }).select("_id requestNumber status requestType sourceMrfId companyId items "
    + "purchaseOrderId budgetApprovalMode budgetApprovalKind commitmentId commitmentStatus "
    + "approvedShippingCharges approvedDiscount approvedCustomCharges "
    /* `grandTotal` is what `allocateLines` splits. Without it the allocator
       falls back to the sum of the LINES, loses the approved header adjustment
       entirely, and then every allocation it reconstructs disagrees with the
       stored one — so a correctly committed order with freight on it would be
       refused at issue for "not matching the approved split". A projection
       omission does not fail loudly; it quietly changes the answer. */
    + "grandTotal").lean();

  const broken = (what, detail) => fail("PROVENANCE_CHANGED",
    `${po.poNumber || "This order"} can no longer be issued: ${what}. ${detail}`,
    { poNumber: po.poNumber || "", reason: what });

  if (!mrf) throw broken("its material request is no longer available", "Check the material request before issuing.");
  if (!request) throw broken("its purchase request is no longer available", "Check the purchase request before issuing.");
  if (idOf(request.sourceMrfId) !== idOf(mrf._id)) {
    throw broken("the purchase request no longer records this material request as its source",
      "The two records must be reconciled first.");
  }
  if (String(mrf.mrfNumber || "") !== String(po.sourceMrfNumber || "")) {
    throw broken("the material request number has changed since this order was drafted",
      "Raise the order again so its provenance matches.");
  }
  if (request.requestType !== MATERIAL_REQUEST_TYPE) {
    throw broken("its purchase request is no longer a material request", "A service is ordered as a service order.");
  }
  /* ── `ordered` IS THE RIGHT STATE FOR AN ORDER THAT EXISTS ───────────────
     The contextual "Create purchase order" action moves the request to
     `ordered` the moment it raises the order — which is correct, and which
     meant a first version of this check refused to issue every order that door
     produced. An order may be issued while its request is approved, or while
     the request is `ordered` AND this is the order it was ordered as. Any
     other `ordered` request belongs to a different purchase order. */
  const orderedAsThis = request.status === "ordered"
    && idOf(request.purchaseOrderId) === idOf(po._id);
  if (request.status !== ORDERABLE_STATUS && !orderedAsThis) {
    throw broken(
      request.status === "ordered"
        ? "its purchase request was ordered as a different purchase order"
        : `its purchase request is now ${String(request.status).replace(/_/g, " ")}`,
      "Only an approved request, or the order it was raised as, may be issued.");
  }

  /* ── THE MATERIAL REQUEST STILL WANTS THIS MATERIAL ───────────────────────
     Not only that the MRF exists: that the things being bought are still the
     things it asked to have bought. An MRF whose shortfall was withdrawn — or
     re-decided as issue-from-stock — no longer justifies the order. */
  const mrfBuyByItem = new Map();
  for (const line of mrf.items || []) {
    if (num(line.buyQty) <= 0) continue;
    const key = idOf(line.rawItem);
    if (key) mrfBuyByItem.set(key, num(mrfBuyByItem.get(key)) + num(line.buyQty));
  }
  if (!mrfBuyByItem.size) {
    throw broken("its material request no longer has anything to buy",
      "The shortfall was withdrawn or filled from stock after this order was drafted.");
  }

  /* ── FINANCE'S AUTHORITY, PROVED AGAIN ───────────────────────────────────
     A commitment can be released, deleted or re-pointed between drafting and
     issuing, and the mode marker says which of those matters. Re-read through
     the same authority creation used, so the two cannot disagree. */
  let budget;
  try {
    budget = await budgetAuthority(tenant, request);
  } catch (budgetErr) {
    if (budgetErr?.name === "StorePurchaseError") {
      throw broken("its budget authority is no longer valid", budgetErr.message);
    }
    throw budgetErr;
  }
  if (!budget.authorised) {
    throw broken("it is no longer authorised to spend", "Reapprove the purchase request.");
  }

  /* ── THE SUPPLIER IS STILL THE APPROVED SUPPLIER ─────────────────────────
     A draft re-pointed at another vendor would commit money Finance approved
     for one supplier to a different one. */
  const approvedSupplier = supplierOf(request);
  const poVendorId = idOf(po.vendor);

  if (approvedSupplier.vendorId) {
    /* ── AN APPROVED ID MUST SURVIVE EXACTLY ───────────────────────────────
       A name is not a substitute for an approved identity. The previous check
       only compared ids when the ORDER still had one, so removing the order's
       vendor id while leaving its vendor name intact passed — and the order
       then went out against a supplier nobody had approved by identity.
       Two suppliers can share a name; only the id says which. */
    if (!poVendorId) {
      throw broken("its supplier id has been removed",
        "The purchase request approved a specific supplier, and a matching name is not the same supplier.");
    }
    if (poVendorId !== idOf(approvedSupplier.vendorId)) {
      throw broken("its supplier is not the one on the approved purchase request",
        "An approved supplier cannot be changed on the order — revise and reapprove the request.");
    }
    /* Still this company's, and still readable — a snapshot that has drifted
       from the identity is its own problem. */
    const v = await Vendor.findOne({ _id: approvedSupplier.vendorId, companyId: tenant.companyId })
      .select("_id companyName").lean().catch(() => null);
    if (!v) {
      throw broken("its approved supplier is no longer available to this company",
        "Reapprove the purchase request with a supplier on this company's supplier master.");
    }
    if (String(po.vendorName || "").trim() && v.companyName
        && String(po.vendorName).trim().toLowerCase() !== String(v.companyName).trim().toLowerCase()) {
      throw broken("its stored supplier name no longer matches the supplier it is addressed to",
        "Raise the order again so the two agree.");
    }
  } else if (approvedSupplier.vendorName) {
    /* A genuinely name-only approval — an older request that never named an
       id — keeps the normalised-name comparison it has always had. */
    if (String(po.vendorName || "").trim().toLowerCase()
        !== approvedSupplier.vendorName.trim().toLowerCase()) {
      throw broken("its supplier name does not match the approved purchase request",
        "Revise and reapprove the request to change the supplier.");
    }
  }

  /* ── THE WHOLE APPROVED SET, EXACTLY ONCE EACH ───────────────────────────
     A2 orders an approved request in full, so the order must still BE that
     request. An earlier version looped only over the lines still on the
     purchase order, which let a draft delete or cancel one approved line and
     issue the rest — ordering three quarters of what Finance approved while
     the request was marked ordered in full, stranding the remainder behind a
     request that can never be ordered again.

     So the check is on the SET: every approved line present, exactly once, and
     nothing else. */
  const approvedById = new Map((request.items || []).map((l) => [idOf(l._id), l]));
  const poLines = po.items || [];

  const seen = new Map();
  for (const line of poLines) {
    const key = idOf(line.spendLineId);
    if (!key) {
      throw broken("one of its lines does not say which approved line it is for",
        "Raise the order again from its purchase request.");
    }
    if (!approvedById.has(key)) {
      throw broken(`${line.itemName || "a line"} on it is not on the approved purchase request`,
        "The request was revised after this order was drafted.");
    }
    if (seen.has(key)) {
      throw broken(`${line.itemName || "a line"} appears on it more than once`,
        "Raise the order again from its purchase request.");
    }
    seen.set(key, line);
  }
  for (const [key, approved] of approvedById) {
    if (!seen.has(key)) {
      throw broken(`${approved.name || "an approved line"} is missing from it`,
        "A purchase order covers the whole approved request — to order part of it, the request must be split and reapproved.");
    }
  }
  /* A cancelled governed line is a missing line wearing a different hat. */
  const cancelled = poLines.find((l) => String(l.status) === "CANCELLED");
  if (cancelled) {
    throw broken(`${cancelled.itemName || "one of its lines"} has been cancelled`,
      "The whole approved request is ordered together — cancel the order, or revise and reapprove the request.");
  }

  /* What OTHER orders have already taken, so this one is measured against what
     is genuinely left rather than against the full approval. */
  const { byLine } = await orderedQuantities(tenant, request);

  for (const line of poLines) {
    const key = idOf(line.spendLineId);
    const approved = approvedById.get(key);

    if (idOf(approved.rawItem) !== idOf(line.rawItem)) {
      throw broken(`the approved material for ${line.itemName || "one line"} is not the one on this order`,
        "An approved item cannot be replaced without reapproval.");
    }
    /* And the material-request line behind it, so the chain holds end to end. */
    if (idOf(approved.sourceMrfLineId) !== idOf(line.sourceMrfLineId)) {
      throw broken(`${line.itemName || "a line"} no longer points at the material-request line it was raised from`,
        "Raise the order again from its material request.");
    }
    const mrfLine = (mrf.items || []).find((i) => idOf(i._id) === idOf(line.sourceMrfLineId));
    if (!mrfLine || num(mrfLine.buyQty) <= 0) {
      throw broken(`${line.itemName || "a line"} is no longer something its material request is buying`,
        "The shortfall was withdrawn or filled from stock after this order was drafted.");
    }
    if (num(line.quantity) > num(mrfLine.buyQty) + TOLERANCE) {
      throw broken(`${line.itemName || "a line"} is for more than its material request decided to buy`,
        `Only ${num(mrfLine.buyQty)} ${mrfLine.unit || ""} is being bought.`.trim());
    }

    const elsewhere = Math.max(0, num(byLine.get(key)) - num(line.quantity));
    const remaining = Math.max(0, num(approved.quantity) - elsewhere);
    if (num(line.quantity) > remaining + TOLERANCE) {
      throw broken(`${line.itemName || "a line"} is for ${num(line.quantity)} but only ${remaining} remains approved`,
        "The purchase request must be revised and reapproved for a larger quantity.");
    }

    /* ── EXACT, NOT MERELY "NOT MORE" ──────────────────────────────────────
       Checking only for excess lets an understated document through, and an
       understated document is not harmless: ₹100,000 of lines under a zero
       header total makes the order, the budget and the eventual invoice
       disagree, and somebody reconciles the difference months later. Equality
       within half a paisa, both ways. */
    if (!sameMoney(num(line.quantity), num(approved.quantity))) {
      throw broken(`${line.itemName || "a line"} is for ${num(line.quantity)} but ${num(approved.quantity)} was approved`,
        "The whole approved quantity is ordered together.");
    }
    if (!sameMoney(line.unitPrice, approved.rate)) {
      throw broken(`the rate on ${line.itemName || "a line"} is ${money(line.unitPrice)}, not the approved ${money(approved.rate)}`,
        "A different price — higher or lower — is a commercial change, and belongs on the purchase request.");
    }
    if (!sameMoney(num(line.gstRate), num(approved.gstPercent))) {
      throw broken(`the tax rate on ${line.itemName || "a line"} is not the approved ${num(approved.gstPercent)}%`,
        "Revise and reapprove the purchase request to change the tax treatment.");
    }
    const expectedNet = money(num(line.quantity) * money(line.unitPrice));
    if (!sameMoney(line.totalPrice, expectedNet)) {
      throw broken(`the line total on ${line.itemName || "a line"} does not follow from its quantity and rate`,
        "Raise the order again from its purchase request.");
    }
    const expectedTax = typeof approved.taxAmount === "number"
      ? money(approved.taxAmount)
      : money((expectedNet * num(approved.gstPercent)) / 100);
    if (!sameMoney(line.gstAmount, expectedTax)) {
      throw broken(`the tax amount on ${line.itemName || "a line"} is ${money(line.gstAmount)}, not the approved ${expectedTax}`,
        "An amount that does not follow from the approved rate makes the order and the invoice disagree.");
    }
    /* Per-line charges move the line total, so they are the approval's too. */
    if (num(line.itemChargesTotal) > TOLERANCE
        || (Array.isArray(line.itemCharges) && line.itemCharges.length)) {
      throw broken(`${line.itemName || "a line"} has charges that were not approved`,
        "Charges belong on the purchase request, where Finance sees the total they make.");
    }
  }

  /* ── THE ADJUSTMENTS ARE THE APPROVED ONES, EXACTLY ─────────────────────
     Shipping, a discount and other charges are approved on the purchase
     request; the order carries them. Compared for EQUALITY, not merely for
     excess: a charge quietly removed from a draft leaves the order, the budget
     and the eventual invoice disagreeing just as surely as one quietly added. */
  const approvedShipping = money(request.approvedShippingCharges);
  const approvedDiscount = money(request.approvedDiscount);
  const approvedCustom = (request.approvedCustomCharges || [])
    .filter((c) => c && String(c.label || "").trim());
  const approvedCustomTotal = money(approvedCustom.reduce((t, c) => t + num(c.amount), 0));

  /* The same reconciliation as creation, on the record as it stands now — a
     request's total can go stale between drafting and issuing. */
  const reconciliation = spendAdjustments.reconciles(request, TOLERANCE);
  if (!reconciliation.ok) {
    throw broken(
      `its purchase request now records ${reconciliation.stored} but its lines and approved charges come to ${reconciliation.expected}`,
      "Requote and reapprove the purchase request before issuing.",
    );
  }
  const poCustom = Array.isArray(po.customCharges) ? po.customCharges : [];
  const poCustomTotal = money(poCustom.reduce((t, c) => t + num(c.amount), 0));

  if (!sameMoney(po.shippingCharges, approvedShipping)) {
    throw broken(`its shipping is ${money(po.shippingCharges)}, not the approved ${approvedShipping}`,
      "Charges are set on the purchase request — revise and reapprove it to change one.");
  }
  if (!sameMoney(po.discount, approvedDiscount)) {
    throw broken(`its discount is ${money(po.discount)}, not the approved ${approvedDiscount}`,
      "Revise and reapprove the purchase request to change it.");
  }
  /* The same canonical comparison as creation — one rule, both doors. */
  if (!sameCharges(poCustom, approvedCustom)) {
    throw broken("its charges are not the ones the purchase request approved",
      `Approved: ${approvedCustom.map((c) => `${c.label} ${money(c.amount)}`).join(", ") || "none"}. `
      + "Revise and reapprove the purchase request to change them.");
  }

  /* ── AND THE HEADER RECONCILES EXACTLY TO THE LINES ──────────────────────
     Checked last, because a header that disagrees with lines which each passed
     means the header itself was written by something other than this service.
     A smaller total is refused as firmly as a larger one. */
  const lineSum = money(poLines.reduce((t, l) => t + money(l.totalPrice), 0));
  const taxSum = money(poLines.reduce((t, l) => t + money(l.gstAmount), 0));
  const expectedTotal = money(lineSum + taxSum + approvedShipping + approvedCustomTotal - approvedDiscount);

  if (!sameMoney(po.subtotal, lineSum)) {
    throw broken(`its subtotal is ${money(po.subtotal)} but its lines come to ${lineSum}`,
      "Raise the order again from its purchase request.");
  }
  if (!sameMoney(po.taxAmount, taxSum)) {
    throw broken(`its tax total is ${money(po.taxAmount)} but its lines' tax comes to ${taxSum}`,
      "Raise the order again from its purchase request.");
  }
  if (!sameMoney(po.totalAmount, expectedTotal)) {
    throw broken(`its total is ${money(po.totalAmount)} but its lines and approved charges come to ${expectedTotal}`,
      "A total that does not follow from the order makes the purchase order, the budget and the invoice disagree.");
  }

  /* ── AND THE PROMISE STILL COVERS IT ─────────────────────────────────────
     Re-checked here rather than trusted from creation: a commitment can be
     released or partly released while a draft sits. */
  assertCommitmentCovers(request, budget, expectedTotal, po.poNumber);

  return { governed: true, legacy: false, mrf, request, budget };
}

/* ══════════════════════════════════════════════════════════════════════════
 * THE SELECTOR — WHICH MATERIAL REQUESTS COULD BE ORDERED AGAINST
 * ═════════════════════════════════════════════════════════════════════════ */

/** How many material requests one selector read will ever scan. */
const SELECTOR_CAP = () => Number(process.env.SP_MRF_SELECTOR_CAP || 200);

/**
 * The material requests a buyer may choose from, newest first.
 *
 * ── ELIGIBLE FIRST, INELIGIBLE EXPLAINED ────────────────────────────────────
 * A request that cannot be ordered against is still shown — but disabled, with
 * the exact reason and somewhere to go. Hiding it answers "why isn't my MRF in
 * the list?" with silence, and the buyer's next step is upstream anyway.
 *
 * Bounded, and company-scoped by the tenant filter: never every historical
 * request, and never another company's.
 */
async function selectableMrfs(tenant, { search = "", limit } = {}) {
  const cap = Math.min(Number(limit) || SELECTOR_CAP(), SELECTOR_CAP());

  /* Only requests with something to buy. A request fulfilled entirely from
     stock is not a purchasing candidate and would only be noise. */
  const base = { "items.buyQty": { $gt: 0 } };
  const rx = search
    ? new RegExp(String(search).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i")
    : null;

  const filter = { ...tenantContext.tenantFilter(tenant), ...base };
  if (rx) {
    /* Folded under `$and`: assigning a second `$or` over the tenancy clause
       would replace it and search across companies. */
    const tenancy = filter.$or;
    delete filter.$or;
    filter.$and = [
      ...(tenancy ? [{ $or: tenancy }] : []),
      { $or: [{ mrfNumber: rx }, { requestedForDept: rx }, { "items.rawItemName": rx }] },
    ];
  }

  const [storedMatchCount, docs] = await Promise.all([
    MRF.countDocuments(filter),
    MRF.find(filter)
      .select("mrfNumber requestedForDept requestedForName status fulfilmentDecision "
        + "spendRequestId spendRequestNumber createdAt items.rawItemName items.unit "
        + "items.requestedQty items.issuedQty items.buyQty")
      .sort({ createdAt: -1, _id: -1 })
      .limit(cap)
      .lean(),
  ]);

  /* One read for every candidate's request, rather than one per row. */
  const requestIds = docs.map((m) => m.spendRequestId).filter(Boolean);
  const requests = requestIds.length
    ? await SpendRequest.find({
      _id: { $in: requestIds }, ...tenantContext.tenantFilter(tenant),
    }).select("requestNumber status requestType sourceMrfId budgetApprovalKind commitmentId items").lean()
    : [];
  const byId = new Map(requests.map((r) => [idOf(r._id), r]));

  /* And one read for what has already been ordered against them. */
  const orders = requestIds.length
    ? await PurchaseOrder.find({
      spendRequestId: { $in: requestIds },
      status: { $in: CONSUMES_QUANTITY },
      ...tenantContext.tenantFilter(tenant),
    }).select("spendRequestId poNumber items.spendLineId items.quantity").lean()
    : [];
  const orderedByRequest = new Map();
  for (const po of orders) {
    const key = idOf(po.spendRequestId);
    orderedByRequest.set(key, (orderedByRequest.get(key) || 0)
      + (po.items || []).reduce((t, l) => t + num(l.quantity), 0));
  }

  const rows = docs.map((mrf) => {
    const buyLines = (mrf.items || []).filter((i) => num(i.buyQty) > 0);
    const request = mrf.spendRequestId ? byId.get(idOf(mrf.spendRequestId)) : null;

    /* The exact reason, in the buyer's terms, with the next step. */
    let eligible = false;
    let reason = null;
    let correction = null;
    if (!request || request.requestType !== MATERIAL_REQUEST_TYPE) {
      reason = "No approved purchase request yet — sourcing and budget are agreed there first.";
      correction = `/store/dashboard/order-requests/mrf/${idOf(mrf._id)}`;
    } else if (idOf(request.sourceMrfId) !== idOf(mrf._id)) {
      reason = "Its purchase request records a different material request. The two must be reconciled.";
      correction = `/store/dashboard/order-requests/quote/${idOf(request._id)}`;
    } else if (request.status !== ORDERABLE_STATUS) {
      reason = `Purchase request ${request.requestNumber} is ${String(request.status).replace(/_/g, " ")} — not yet approved to spend.`;
      correction = `/store/dashboard/order-requests/quote/${idOf(request._id)}`;
    } else {
      const approved = (request.items || []).reduce((t, l) => t + num(l.quantity), 0);
      const ordered = num(orderedByRequest.get(idOf(request._id)));
      if (ordered >= approved && approved > 0) {
        reason = "Everything approved on its purchase request is already on order.";
        correction = `/store/dashboard/order-requests/quote/${idOf(request._id)}`;
      } else {
        eligible = true;
      }
    }

    return {
      id: idOf(mrf._id),
      mrfNumber: mrf.mrfNumber || "",
      /* The origin, so a buyer knows whose need this is. */
      department: mrf.requestedForDept || "",
      requestedForName: mrf.requestedForName || "",
      status: mrf.status || "",
      raisedAt: mrf.createdAt || null,
      /* Whether it has a purchase shortfall, and how much of one. */
      hasPurchaseShortfall: buyLines.length > 0,
      shortfallLineCount: buyLines.length,
      shortfallLines: buyLines.map((i) => ({
        itemName: i.rawItemName || "",
        unit: i.unit || "",
        requestedQty: num(i.requestedQty),
        issuedQty: num(i.issuedQty),
        buyQty: num(i.buyQty),
      })),
      /* Its purchasing readiness — the chain, named as three separate things
         so nobody reads the purchase request as the material request. */
      purchaseRequestNumber: request?.requestNumber || "",
      purchaseRequestStatus: request?.status || "",
      budgetApprovalKind: request?.budgetApprovalKind || null,
      hasCommitment: Boolean(request?.commitmentId),
      eligible,
      ineligibleReason: reason,
      correction,
    };
  });

  /* Eligible first, then newest — the ones a buyer can act on now are the ones
     they are looking for. */
  rows.sort((a, b) => (a.eligible === b.eligible ? 0 : a.eligible ? -1 : 1));

  return {
    rows,
    coverage: {
      scannedCount: docs.length,
      scanCap: cap,
      storedMatchCount,
      truncated: storedMatchCount > cap,
      note: storedMatchCount > cap
        ? `Showing the newest ${cap} material requests with something to buy; older ones exist. Search to narrow it.`
        : null,
    },
  };
}

/**
 * Everything the form shows once an MRF is chosen.
 *
 * ── THREE DOCUMENTS, THREE NAMES ────────────────────────────────────────────
 * The material request is the operational need and the stock shortfall. The
 * purchase request is sourcing and budget approval. The purchase order is the
 * supplier commitment. Calling the second one an MRF — as screens have — hides
 * the fact that approval happened somewhere else entirely.
 */
async function provenanceSummary(tenant, sourceMrfId) {
  const chain = await resolveChain(tenant, { sourceMrfId });
  const mrf = chain.mrf;
  const request = chain.spendRequest;

  return {
    materialRequest: {
      id: idOf(mrf._id),
      number: mrf.mrfNumber || "",
      department: mrf.requestedForDept || "",
      requestedForName: mrf.requestedForName || "",
      status: mrf.status || "",
      lines: (mrf.items || []).filter((i) => num(i.buyQty) > 0).map((i) => ({
        itemName: i.rawItemName || "",
        unit: i.unit || "",
        requestedQty: num(i.requestedQty),
        /* What the shelf covered, and what has to be bought. */
        satisfiedFromStock: num(i.issuedQty),
        requiringPurchase: num(i.buyQty),
      })),
    },
    purchaseRequest: {
      id: idOf(request._id),
      number: request.requestNumber || "",
      status: request.status || "",
      financeApproved: chain.budget.authorised,
      budgetApprovalKind: chain.budget.kind,
      budgetHead: request.budgetAccountHeadId ? idOf(request.budgetAccountHeadId) : null,
      budgetHeadName: request.plannedItemName || request.budgetDepartment || "",
      hasCommitment: Boolean(chain.budget.commitmentId),
      supplierName: chain.vendorName || "",
      approvedAmount: chain.totals.totalAmount,
    },
    orderable: chain.lines.map((l) => ({
      spendLineId: idOf(l.spendLineId),
      itemName: l.itemName,
      unit: l.unit,
      approvedQuantity: l.approvedQuantity,
      alreadyOrdered: l.alreadyOrdered,
      remainingQuantity: l.remainingQuantity,
      unitPrice: l.unitPrice,
      gstRate: l.gstRate,
    })),
    totals: chain.totals,
  };
}

module.exports = {
  resolveChain, resolveForRequest, resolveApproved,
  selectableMrfs, provenanceSummary, SELECTOR_CAP,
  assertIssuable, isLegacyOrder, isGovernedOrder, isAdHocOrder, provenanceFields, resolveAdHoc, MRF_RULE_ON,
  PROVENANCE_POLICY, LEGACY_POLICY, SUPPORTED_POLICIES, isSupportedPolicy,
  PROVENANCE_CUTOVER, unprovenReason,
  loadMrf, loadRequest, shortfallLines, budgetAuthority, supplierOf, orderedQuantities,
  BUDGET_MODE, LIVE_COMMITMENT, Acc_BudgetCommitment, TOLERANCE, sameMoney,
  assertCommitmentCovers, lineAllocation, sameCharges, chargeSignature,
  ORDERABLE_STATUS, MATERIAL_REQUEST_TYPE, CONSUMES_QUANTITY,
  MRF, SpendRequest, PurchaseOrder, Vendor,
};

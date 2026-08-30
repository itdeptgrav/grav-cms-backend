/**
 * services/spendApproval.service.js
 *
 * WHO HAS TO SAY YES BEFORE A PURCHASE OR SERVICE IS ORDERED.
 *
 * ── THE CHAIN ───────────────────────────────────────────────────────────────
 *
 *   employee raises  →  TL  →  Finance  →  Store & Purchase raises the PO/WO
 *
 * Three different questions, asked by three different people:
 *
 *   TL       does this department actually need it?
 *   Finance  should the company spend this money, on this head?
 *   Store    who do we buy it from, and on what paperwork?
 *
 * Only the first two are approvals. Store is the doer at the end — the request
 * is already agreed by the time it reaches them, and their job is to raise the
 * order, not to re-decide it.
 *
 * ── A TL'S OWN REQUEST SKIPS THE TL STEP ────────────────────────────────────
 * A TL approving their own request is not an approval. Theirs starts at
 * Finance, which still leaves two other people between them and the money.
 *
 * Whether somebody IS a TL is read from the org chart — do they manage anyone —
 * rather than from a role somebody typed. A title can be stale; a reporting
 * line is the thing the company actually runs on, and it is the same source
 * mrfApprover already routes MRFs by.
 *
 * ── MATERIAL REQUESTS DO NOT COME THROUGH HERE ──────────────────────────────
 * An MRF asks the store to issue stock the company already owns. That spends
 * nothing, so there is no finance question to ask, and its chain — employee,
 * TL, store — is untouched by any of this.
 */

"use strict";

/* The one rule about whose approval a request waits for. Shared with the
   intake desk and with MRF so three collections cannot answer it
   differently — see services/tlRouting.service.js. */
const tlRouting = require("./tlRouting.service");

/** Where a request sits. One field, so nothing can disagree with itself. */
const PENDING_TL = "pending_tl";
const PENDING_FINANCE = "pending_finance";
const APPROVED = "approved";
const ORDERED = "ordered";
const REJECTED = "rejected";
const CANCELLED = "cancelled";
const DRAFT = "draft";

/* ── THE REQUESTER CHECKS WHAT STORE FOUND ──────────────────────────────────
 * Three states between Store pricing a quote and finance seeing it, and they
 * exist because of one failure mode: Store buys the wrong thing.
 *
 * A requester writes "a mouse, the good one". Store, doing their job well,
 * sources a mouse — the wrong model, from a vendor with a six-week lead time,
 * at a price the requester would never have asked for had they known. Finance
 * approves it because the figure fits the head. Nobody was careless, and the
 * wrong thing is now on order with the money committed.
 *
 * So the person who knows what they meant sees the actual item, spec, vendor,
 * price and date BEFORE anybody approves money against it. They confirm, ask
 * Store to look again, or withdraw.
 *
 * AWAITING_CONFIRMATION   with the requester, nobody has approved anything
 * REVISION_REQUESTED      back with Store, the requester said not this
 * CONFIRMED               the requester agreed; Store may now send it on
 *
 * ── AND WHY THE BUDGET IS CHECKED AT CONFIRMATION ───────────────────────────
 * That is the first moment a real figure exists AND the person who owns the
 * head has seen it. Checking earlier would test the requester's guess;
 * checking later means finance is the first to notice, and by then the
 * requester has agreed to something they cannot have.
 */
const AWAITING_CONFIRMATION = "awaiting_requester_confirmation";
const REVISION_REQUESTED = "requester_revision_requested";
const CONFIRMED = "requester_confirmed";
/* ── SENT BACK TO THE REQUESTER OVER MONEY, NOT OVER NEED ───────────────────
 * Distinct from `rejected` on purpose. A rejection is finance saying no. This
 * is finance saying "not at this figure, against this head" — the need is not
 * in question and neither is the quote, and the request is still alive. The
 * requester revises it, moves it to another approved head, asks for more
 * budget, or withdraws.
 *
 * Its own state because every one of those is a different next action, and a
 * request parked in `rejected` offers none of them. */
const BUDGET_EXCEPTION = "budget_exception";
/* Written by the first version of this router, before the chain existed. Kept
   so a row saved then still reads, and treated as waiting on the TL. */
const LEGACY_SUBMITTED = "submitted";

const OPEN_STATUSES = [PENDING_TL, PENDING_FINANCE, LEGACY_SUBMITTED];

/** What each state is called on screen. */
const STAGE_LABEL = {
  [DRAFT]: "Draft",
  [LEGACY_SUBMITTED]: "Waiting for review",
  [PENDING_TL]: "Waiting for department approval",
  [PENDING_FINANCE]: "Waiting for finance",
  [APPROVED]: "Approved — with Store for fulfilment",
  [ORDERED]: "Ordered",
  [AWAITING_CONFIRMATION]: "Waiting for you to confirm what Store found",
  [REVISION_REQUESTED]: "Back with Store to look again",
  [CONFIRMED]: "You confirmed it — with Store to send to finance",
  [BUDGET_EXCEPTION]: "Over budget — back with you",
  [REJECTED]: "Rejected",
  [CANCELLED]: "Withdrawn",
};

/**
 * Where a new request starts.
 *
 * `managesPeople` comes from the org chart. A TL's request begins at finance;
 * everybody else's waits for their TL — unless nobody manages them, in which
 * case there is no TL step to wait for and it begins at finance too. A request
 * parked against an approver who does not exist is a request nobody will ever
 * action.
 */
function startingStatus({ managesPeople = false, hasApprover = false } = {}) {
  if (managesPeople) return PENDING_FINANCE;
  return hasApprover ? PENDING_TL : PENDING_FINANCE;
}

/** Is this person one of finance's approvers? */
function isFinanceApprover(accUser) {
  const role = String(accUser?.role || "").toLowerCase();
  return role === "owner" || role === "approver";
}

/**
 * What this person may do to this request, and why not when they may not.
 *
 * Returns `{ can, step, reason }`. `step` names which approval their yes would
 * be, so the caller records it against the right one rather than inferring it
 * from the status a moment later.
 *
 * The TL step belongs to the manager STORED on the request — resolved from the
 * requester's own `Employee.primaryManager.managerId` when it was raised.
 * `managedIds` (who reports to the viewer right now) answer only for requests
 * that named nobody, which is the legacy case. A TL of another department has
 * no business approving this one's spending, and neither has a manager who
 * inherited these people after the request was already waiting.
 */
function decisionFor({ request, viewer }) {
  const status = String(request?.status || "");
  const no = (reason) => ({ can: false, step: null, reason });

  if (![PENDING_TL, PENDING_FINANCE, LEGACY_SUBMITTED].includes(status)) {
    return no(`This request is ${STAGE_LABEL[status] || status}.`);
  }

  /* Nobody decides their own request, at any step. That is the whole point of
     asking somebody else. Checked here as well as inside the TL rule because
     it applies to the finance step too. */
  if (viewer?.employeeId && request?.requestedById &&
      String(viewer.employeeId) === String(request.requestedById)) {
    return no("You cannot approve your own request.");
  }

  if (status === PENDING_FINANCE) {
    return viewer?.isFinance
      ? { can: true, step: "finance", reason: null }
      : no("Only finance can approve this one.");
  }

  /* pending_tl, and the legacy state that means the same thing.
     Finance may take the TL step when the TL is the blocker and finance is
     going to have to look at it anyway — deliberately NOT allowed, and not
     reachable from here: this branch never consults `isFinance`. Two approvals
     means two people, and letting finance clear both would make the chain one
     person long. */
  const verdict = tlRouting.tlEntitlement({ request, viewer, roleWord: "TL" });
  return verdict.can
    ? { can: true, step: "tl", via: verdict.via, reason: null }
    : no(verdict.reason);
}

/** Where an approved step leaves the request. */
function statusAfter(step) {
  return step === "tl" ? PENDING_FINANCE : APPROVED;
}

module.exports = {
  BUDGET_EXCEPTION,
  AWAITING_CONFIRMATION,
  REVISION_REQUESTED,
  CONFIRMED,
  DRAFT,
  PENDING_TL,
  PENDING_FINANCE,
  APPROVED,
  ORDERED,
  REJECTED,
  CANCELLED,
  LEGACY_SUBMITTED,
  OPEN_STATUSES,
  STAGE_LABEL,
  startingStatus,
  isFinanceApprover,
  decisionFor,
  tlRouting,
  statusAfter,
};

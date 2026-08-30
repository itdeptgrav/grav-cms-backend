/**
 * services/spendFinanceDecision.service.js
 *
 * FINANCE'S ANSWER TO A PRICED SPEND REQUEST.
 *
 * ── WHY THIS IS A SERVICE AND NOT A ROUTE ───────────────────────────────────
 * There are now two doors onto the same decision. Somebody in the Requests app
 * approves from their own desk; somebody in the books approves from Payables →
 * Spend approvals, which is where an accountant actually works and where the
 * budget head, the vendor and the payable all already live.
 *
 * They must be the SAME decision. Approving is the moment money is promised —
 * it writes a budget commitment, and a commitment written one way by one screen
 * and another way by the other is a number nobody can reconcile. So the rule
 * lives here once and both routers call it.
 *
 * ── WHAT IT DOES NOT DECIDE ─────────────────────────────────────────────────
 * WHO may answer. The two doors authenticate differently — one on a CMS
 * employee session, the other on an accounting login — and each knows how to
 * identify its own people. Entitlement is checked by the caller; this function
 * is handed a decision that has already been established as theirs to make.
 *
 * It also does not touch the TL step. That is a different question asked by a
 * different person, and it stays in the Requests router where it belongs.
 */

"use strict";

const chain = require("./spendApproval.service");
const fulfilment = require("./storeFulfilment.service");
const budgetMatch = require("./budgetCommitment.service");

/** Statuses at which finance is the one being asked. */
const AT_FINANCE = [chain.PENDING_FINANCE];

const fail = (status, code, message) => ({ ok: false, status, code, message });

/**
 * Approve or reject, as finance.
 *
 * @param {object}  request  the SpendRequest DOCUMENT (not lean — it is saved)
 * @param {object}  actor    `{ id, email, name }` — who is answering
 * @param {string}  outcome  "approved" | "rejected"
 * @param {string}  note     required on a rejection
 * @param {Date|string|null} expectedPaymentDate  when finance expects to pay
 * @returns {Promise<{ok: true} | {ok: false, status: number, code: string, message: string}>}
 *
 * Mutates and SAVES the request. Returns rather than throws, because both
 * callers turn the answer into an HTTP status and neither wants a stack trace
 * for "this is not priced yet".
 */
async function decide({ request, actor, outcome, note = "", expectedPaymentDate = null } = {}) {
  if (!request) return fail(404, "NOT_FOUND", "Request not found.");

  const status = String(request.status || "");
  if (!AT_FINANCE.includes(status)) {
    return fail(
      400,
      "WRONG_STATE",
      `This request is ${chain.STAGE_LABEL[status] || status} — finance is not the one being asked.`,
    );
  }

  /* A rejection owes a reason. An approval does not — a forced one produces
     "ok", which reads like a reason and is not. */
  if (outcome === "rejected" && !String(note || "").trim()) {
    return fail(400, "NEEDS_REASON", "Say why you are rejecting it.");
  }

  /* ── FINANCE APPROVES MONEY, SO THERE HAS TO BE A FIGURE ────────────────
     A request whose lines carry no rate is one nobody has costed. Approving it
     would be agreeing to an amount that does not exist — and since the
     approval is what writes the commitment, the commitment would be for zero
     against a purchase that is not.

     Rejection is deliberately NOT gated: refusing something unpriced is a
     perfectly good answer, and often the right one. */
  if (outcome !== "rejected") {
    const priced = fulfilment.pricingGate(request);
    if (!priced.ok) return fail(400, "NOT_PRICED", priced.reason);

    /* ── AND THE PERSON WHO ASKED HAS TO HAVE SEEN IT ────────────────────
       A quote can fit the budget perfectly and still be the wrong item from
       the wrong vendor on a six-week lead time. Finance is not equipped to
       notice that — they are reading a figure against a head — so approval is
       refused until the requester has confirmed what Store actually found.

       Only requests raised through the fulfilment flow carry a confirmation;
       one raised directly by the requester IS their own ask, and asking them
       to confirm their own request would be a step that says nothing.

       Rejection stays ungated: refusing an unconfirmed quote is fine, and
       often exactly right. */
    if (request.intakeRequestId && !request.requesterConfirmedAt) {
      return fail(
        409,
        "NOT_CONFIRMED",
        `${request.requestedByName || "The requester"} has not confirmed yet that this is the right item and vendor. It cannot be approved until they have.`,
      );
    }
  }

  const now = new Date();
  const who = actor?.name || "";

  if (outcome === "rejected") {
    request.status = chain.REJECTED;
    request.decidedAt = now;
    request.decidedBy = actor?.id || undefined;
    request.decidedByName = who;
    request.decisionNote = String(note).trim().slice(0, 500);
  } else {
    request.financeApprovedBy = actor?.email || "";
    request.financeApprovedByName = who;
    request.financeApprovedAt = now;
    request.status = chain.statusAfter("finance");

    /* ── FINANCE'S YES IS THE COMMITMENT ────────────────────────────────
       Not the TL's, and not the submission. Until finance agrees, nothing has
       been promised; the moment they do, the money is spoken for even though
       no voucher exists yet.

       What the approval is ON THE RECORD as depends on the head, and finance
       can always say yes: within the envelope, past it, or against no envelope
       at all. A blanket "approved" would lose the one distinction that matters
       when somebody later asks how the year went over. */
    const snap = request.budgetSnapshot;
    request.budgetApprovalKind =
      request.budgetMatchStatus !== "matched"
        ? "unbudgeted"
        : snap && Number(snap.availableAfter) < 0
          ? "over_budget"
          : "within_budget";

    /* Idempotent by the unique index on spendRequestId, not by this read — two
       approvals arriving together would both find nothing and both insert.
       Re-approving is therefore a no-op rather than a second promise. */
    if (!request.commitmentId) {
      let expected = null;
      if (expectedPaymentDate) {
        expected = new Date(expectedPaymentDate);
        if (Number.isNaN(expected.getTime())) {
          return fail(400, "BAD_DATE", "That expected payment date cannot be read.");
        }
      }
      try {
        const { commitment } = await budgetMatch.commit({
          request,
          actor: { email: actor?.email, name: who },
          expectedPaymentDate: expected,
        });
        if (commitment) {
          request.commitmentId = commitment._id;
          request.commitmentStatus = commitment.status;
        }
      } catch (e) {
        console.error("[spend] commitment failed:", e.message);
        /* Nothing is saved on this path, so the request stays exactly where it
           was — approving and then failing to record the promise would leave
           money agreed and untracked, which is worse than not approving. */
        return fail(
          500,
          "COMMITMENT_FAILED",
          "Approved nothing — the budget commitment could not be recorded. Try again.",
        );
      }
    }
  }

  request.history.push({
    at: now,
    by: actor?.id || undefined,
    byName: who,
    action: outcome === "rejected" ? "rejected at finance" : "approved at finance",
    note: String(note || "").trim().slice(0, 500),
  });
  await request.save();

  return { ok: true };
}

module.exports = { decide, AT_FINANCE };

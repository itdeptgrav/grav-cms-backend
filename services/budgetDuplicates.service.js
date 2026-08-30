/**
 * GRAV-CMS-BACKEND/services/budgetDuplicates.service.js
 *
 * "Have you already asked for this?"
 *
 * ── WHY DUPLICATES ARE WORSE THAN NOISE ─────────────────────────────────────
 * Two open supplementaries on one line are two people asking for the same
 * thing, and finance approving both applies the delta twice — arithmetically
 * correct and never what anyone meant. Two open transfers out of one line can
 * each be affordable and not both, so the second fails at APPROVAL, long after
 * the department stopped thinking about it. A duplicate is not a tidiness
 * problem; it is a decision that goes wrong later.
 *
 * ── ONE VOCABULARY, FOUR FLOWS ──────────────────────────────────────────────
 * Each flow has its own state enum and they do not agree with one another —
 * a proposal is never "cancelled", a transfer is never "reviewed". Written out
 * per-flow rather than shared, a guard eventually names a state that cannot
 * occur and silently never fires. So the open sets live here, once, derived
 * from the enums the models actually declare.
 */

/* ── WHAT "OPEN" MEANS, PER FLOW ─────────────────────────────────────────────
 * Every value below appears in its model's own enum. Anything not listed is
 * final: the ask has been decided and a fresh one is legitimate.
 *
 *   proposal      awaiting | submitted | countered   (final: agreed, defaulted)
 *   requestedHead requested | clarification          (final: mapped, created, rejected)
 *   adjustment    submitted | reviewed               (final: approved, rejected, cancelled)
 *   transfer      submitted                          (final: approved, rejected, cancelled)
 *
 * `transfer` has no "reviewed" state — the enum is
 * submitted|approved|rejected|cancelled. Listing one here would be a guard
 * clause that can never match.
 */
const OPEN = {
  proposal: ["awaiting", "submitted", "countered"],
  requestedHead: ["requested", "clarification"],
  adjustment: ["submitted", "reviewed"],
  transfer: ["submitted"],
};

/** Machine-readable codes, as the API contract. */
const CODES = {
  proposal: "duplicate_proposal",
  requestedHead: "duplicate_head_request",
  adjustment: "duplicate_adjustment",
  transfer: "duplicate_transfer",
};

const isOpen = (flow, state) => OPEN[flow].includes(String(state || ""));

/**
 * A head name reduced to what makes two of them the same ask.
 *
 * Case and spacing are how the same intention gets typed twice — "Claude
 * Team", "claude team" and "Claude  Team" are one request for one head. The
 * ORIGINAL spelling is still what gets stored; this is only ever used to
 * compare.
 */
function normaliseHeadName(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

/** Not `_id`-safe on its own — always compare with String(). */
const sameId = (a, b) => Boolean(a) && Boolean(b) && String(a) === String(b);

/**
 * An open proposal line for the same head, in the same cycle, for the same
 * department.
 *
 * `exceptId` is the row being edited: a revise must not collide with itself.
 * Nature is compared as well as ledger because one ledger can legitimately
 * carry both a revenue target and an expense budget.
 */
function openProposalFor(budget, { department, ledgerId, nature, exceptId } = {}) {
  if (!ledgerId) return null;
  return (
    (budget.budgetRequests || []).find(
      (r) =>
        r &&
        !sameId(r._id, exceptId) &&
        isOpen("proposal", r.state) &&
        sameId(r.ledgerId, ledgerId) &&
        (r.nature || "expense") === (nature || "expense") &&
        String(r.department || "").trim().toLowerCase() ===
          String(department || "").trim().toLowerCase(),
    ) || null
  );
}

/**
 * An open ask for the same head name, of the same kind, in the same cycle.
 *
 * Compared on the normalised name because that is what makes two asks the
 * same — the department that types "Claude team" today and "Claude Team"
 * tomorrow is asking once.
 */
function openHeadRequestFor(budget, { name, nature, department, exceptId } = {}) {
  const want = normaliseHeadName(name);
  if (!want) return null;
  return (
    (budget.budgetRequests || []).find(
      (r) =>
        r &&
        !sameId(r._id, exceptId) &&
        r.requestedHead?.name &&
        isOpen("requestedHead", r.requestedHead.state) &&
        normaliseHeadName(r.requestedHead.name) === want &&
        (r.requestedHead.nature || "expense") === (nature || "expense") &&
        String(r.department || "").trim().toLowerCase() ===
          String(department || "").trim().toLowerCase(),
    ) || null
  );
}

/**
 * An open adjustment of the same kind against the same line.
 *
 * `origin` narrows it to the department's own asks when given: finance
 * raising its own supplementary on a line a department is already asking
 * about is a different conversation, and blocking finance on a department's
 * ask would be the budget module refusing its owner.
 */
function openAdjustmentFor(budget, { lineId, type, origin, exceptId } = {}) {
  return (
    (budget.adjustments || []).find(
      (a) =>
        a &&
        !sameId(a._id, exceptId) &&
        isOpen("adjustment", a.state) &&
        sameId(a.targetItemId, lineId) &&
        a.type === type &&
        (origin ? (a.origin || "finance") === origin : true),
    ) || null
  );
}

/** An open transfer along exactly the same route. */
function openTransferFor(budget, { fromLineId, toLineId, exceptId } = {}) {
  return (
    (budget.transfers || []).find(
      (t) =>
        t &&
        !sameId(t._id, exceptId) &&
        isOpen("transfer", t.state) &&
        sameId(t.fromItemId, fromLineId) &&
        sameId(t.toItemId, toLineId),
    ) || null
  );
}

/**
 * What other open transfers have already spoken for on this source line.
 *
 * Two transfers out of one line can each be affordable and not both. The
 * amount already committed by open asks is therefore subtracted from what a
 * new one may claim — otherwise the second one is accepted here and refused
 * at approval, which is the worst place to find out.
 *
 * This is a courtesy check, not the authority: availability is recomputed
 * from posted vouchers when finance approves, because spend keeps arriving.
 */
function committedFromLine(budget, { fromLineId, exceptId } = {}) {
  return (budget.transfers || [])
    .filter(
      (t) =>
        t &&
        !sameId(t._id, exceptId) &&
        isOpen("transfer", t.state) &&
        sameId(t.fromItemId, fromLineId),
    )
    .reduce((sum, t) => sum + (Number(t.amount) || 0), 0);
}

module.exports = {
  OPEN,
  CODES,
  isOpen,
  normaliseHeadName,
  openProposalFor,
  openHeadRequestFor,
  openAdjustmentFor,
  openTransferFor,
  committedFromLine,
};

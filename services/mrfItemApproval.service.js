// services/mrfItemApproval.service.js
//
// ITEM-WISE APPROVAL OF A MATERIAL REQUEST — the rules, in one place.
//
// A request used to be decided whole: the manager pressed Approve or Reject and
// every line followed. Now each line is decided on its own, and a line the
// manager approves goes to the Store AT ONCE, without waiting for the rest of
// the request. Three of five approved means three lines on the Store's desk
// while two still sit in the manager's queue.
//
// ── WHY THE REQUEST'S `status` DID NOT GROW NEW VALUES ─────────────────────
// `MRF.status` is the Store's lifecycle (PENDING → APPROVED → PARTIALLY_ISSUED
// → ISSUED …) and every issue, reservation, fulfilment and report keys on it.
// "Partially approved" is not a Store state, it is a fact about the manager's
// decisions — so it lives beside it, in `approvalStatus`, and `status` keeps
// meaning what it always meant:
//
//   status PENDING   → no line has reached the Store yet
//   status APPROVED  → at least one line is with the Store (`tlApproved`)
//   status REJECTED  → every line was rejected
//
// ── WHAT A LINE'S DECISION IS ───────────────────────────────────────────────
// Recorded on `items[].approval` (decision, quantities, reason, who, when).
// Lines decided before this existed carry no record; `lineApproval` derives
// theirs from the request-level fields those decisions wrote, so an old
// request reads the same whether or not the backfill migration has run
// (scripts/migrations/mrf-item-approval-backfill.js uses this same function).
//
// ── A REDUCED QUANTITY ──────────────────────────────────────────────────────
// A manager may approve less than was asked. `approval.requestedQty` keeps
// what was asked; the line's own `requestedQty` becomes the APPROVED quantity,
// because that field is what every Store path issues, reserves and buys
// against — one assignment here instead of a second "approved" figure that
// thirty Store calculations would each have to learn to prefer.
//
// Pure: no database, no Express. The routes call it and save the document.
"use strict";

const DECISION = Object.freeze({
  PENDING: "PENDING",
  APPROVED: "APPROVED",
  REJECTED: "REJECTED",
});

const APPROVAL_STATUS = Object.freeze({
  AWAITING_APPROVAL: "AWAITING_APPROVAL",       // nothing decided yet
  PARTIALLY_PROCESSED: "PARTIALLY_PROCESSED",   // some lines decided, some still waiting
  APPROVED: "APPROVED",                         // every line approved in full
  PARTIALLY_APPROVED: "PARTIALLY_APPROVED",     // all decided; some approved, some rejected or reduced
  REJECTED: "REJECTED",                         // every line rejected
  CANCELLED: "CANCELLED",                       // withdrawn while lines still waited
});

/** The approval states in which a line can still be waiting on the manager. */
const AWAITING_STATUSES = Object.freeze([
  APPROVAL_STATUS.AWAITING_APPROVAL,
  APPROVAL_STATUS.PARTIALLY_PROCESSED,
]);

/** Request states in which nothing more may be decided. */
const CLOSED_REQUEST_STATES = new Set(["REJECTED", "CANCELLED", "COMPLETED", "UNFULFILLED"]);

const REASON_MAX = 500;
const TOL = 1e-6;
const r4 = (n) => Math.round((Number(n) || 0) * 10000) / 10000;
const str = (v) => (v === undefined || v === null ? "" : String(v));
const idOf = (line) => str(line && (line._id ?? line.id));

/* ══════════════════════════════════════════════════════════════════════════
 * Reading a line's decision
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * How many lines the manager rejected when a request was approved the old,
 * whole-request way — read from the event that approval wrote ("Approved with
 * 2 item(s) rejected."). Null when no such event exists (very old records).
 */
function legacyRejectedAtApprovalCount(mrf) {
  const ev = (mrf.statusHistory || []).find((e) => e && e.action === "TL_APPROVED");
  if (!ev) return null;
  const m = /Approved with (\d+) item\(s\) rejected/.exec(str(ev.detail));
  return m ? Number(m[1]) : 0;
}

/**
 * Did the MANAGER reject this line, on a request decided before item-wise
 * approval? `REJECTED` is overloaded on old records: the store also writes it
 * when it rejects an unmatched line (with its note in `storeNotes`), and a
 * cancellation writes it on every open line.
 */
function legacyManagerRejected(line, mrf) {
  if (line.itemStatus !== "REJECTED") return false;
  if (str(line.storeNotes).trim()) return false;
  const n = legacyRejectedAtApprovalCount(mrf);
  if (n === 0) return false;
  if (n === null && mrf.status === "CANCELLED") return false;
  return true;
}

/**
 * The manager's decision on one line, normalised.
 *
 * @returns {{
 *   decision: "PENDING"|"APPROVED"|"REJECTED",
 *   requestedQty: number, approvedQty: number, rejectedQty: number,
 *   reason: string, decidedByName: string, decidedById: string,
 *   decidedAt: Date|string|null, recorded: boolean, automatic: boolean,
 * }}
 *   `recorded` — read from the line's own record rather than derived.
 *   `automatic` — no manager decided it (auto-forwarded, raised by the store).
 */
function lineApproval(line, mrf) {
  const a = line && line.approval;
  if (a && a.decision && Object.values(DECISION).includes(a.decision)) {
    const requestedQty = r4(a.requestedQty ?? line.requestedQty);
    const approvedQty = a.decision === DECISION.APPROVED
      ? r4(a.approvedQty ?? line.requestedQty)
      : 0;
    const rejectedQty = a.decision === DECISION.PENDING
      ? 0
      : a.decision === DECISION.REJECTED
        ? r4(a.rejectedQty ?? requestedQty)
        : r4(a.rejectedQty ?? Math.max(0, requestedQty - approvedQty));
    return {
      decision: a.decision,
      requestedQty, approvedQty, rejectedQty,
      reason: str(a.reason),
      decidedByName: str(a.decidedByName),
      decidedById: str(a.decidedById),
      decidedAt: a.decidedAt || null,
      recorded: true,
      automatic: false,
    };
  }

  /* ── No record: derive it from what the whole-request decision wrote ── */
  const requestedQty = r4(line && line.requestedQty);
  const base = {
    requestedQty, approvedQty: 0, rejectedQty: 0, reason: "",
    decidedByName: "", decidedById: "", decidedAt: null, recorded: false, automatic: false,
  };

  if (mrf.tlRejected) {
    return {
      ...base,
      decision: DECISION.REJECTED,
      rejectedQty: requestedQty,
      reason: str(mrf.tlRejectionNote || mrf.rejectionNote),
      decidedByName: str(mrf.tlRejectedByName || mrf.approverName),
      decidedAt: mrf.tlRejectedAt || null,
    };
  }

  if (mrf.tlApproved || mrf.pmApproved) {
    if (legacyManagerRejected(line, mrf)) {
      return {
        ...base,
        decision: DECISION.REJECTED,
        rejectedQty: requestedQty,
        decidedByName: str(mrf.tlApprovedByName || mrf.approverName),
        decidedAt: mrf.tlApprovedAt || null,
      };
    }
    return {
      ...base,
      decision: DECISION.APPROVED,
      approvedQty: requestedQty,
      decidedByName: str(mrf.tlApprovedByName || mrf.approverName),
      decidedAt: mrf.tlApprovedAt || mrf.pmApprovedAt || null,
    };
  }

  /* Reached the store without a manager: auto-forwarded because no manager
     could be resolved, raised by the store on somebody's behalf, or created
     already approved by another desk. Approved, by nobody. */
  if (mrf.autoForwarded || mrf.creationMode === "BYPASS"
    || !["PENDING", "CANCELLED", "REJECTED"].includes(mrf.status)) {
    return { ...base, decision: DECISION.APPROVED, approvedQty: requestedQty, automatic: true };
  }

  /* PENDING, or cancelled before anybody decided. */
  return { ...base, decision: DECISION.PENDING };
}

/** Is this line still waiting for the manager — and can it still be decided? */
function isAwaitingApproval(line, mrf) {
  return !CLOSED_REQUEST_STATES.has(mrf.status)
    && lineApproval(line, mrf).decision === DECISION.PENDING;
}

/**
 * Has this line reached the Store?
 *
 * The Store's screens and every Store action read this: a line the manager has
 * not approved — still waiting, or rejected — is not the Store's to see or act on.
 */
function isWithStore(line, mrf) {
  return lineApproval(line, mrf).decision === DECISION.APPROVED;
}

/** Ids of the lines still waiting on the manager. */
function awaitingLineIds(mrf) {
  return (mrf.items || []).filter((l) => isAwaitingApproval(l, mrf)).map(idOf);
}

/* ══════════════════════════════════════════════════════════════════════════
 * The request's approval status
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * Counts and the derived approval status of a whole request.
 *
 *   all waiting                            → AWAITING_APPROVAL
 *   some decided, some waiting             → PARTIALLY_PROCESSED
 *   all decided, all approved in full      → APPROVED
 *   all decided, any rejected or reduced   → PARTIALLY_APPROVED (if anything was approved)
 *   all decided, nothing approved          → REJECTED
 *   withdrawn while lines waited           → CANCELLED
 */
function approvalSummary(mrf) {
  const lines = (mrf.items || []).map((l) => lineApproval(l, mrf));
  const total = lines.length;
  const pending = lines.filter((l) => l.decision === DECISION.PENDING).length;
  const approved = lines.filter((l) => l.decision === DECISION.APPROVED).length;
  const rejected = lines.filter((l) => l.decision === DECISION.REJECTED).length;
  const reduced = lines.filter((l) => l.decision === DECISION.APPROVED && l.rejectedQty > TOL).length;

  let status;
  if (!total) {
    status = mrf.status === "PENDING" ? APPROVAL_STATUS.AWAITING_APPROVAL
      : mrf.status === "REJECTED" ? APPROVAL_STATUS.REJECTED
        : mrf.status === "CANCELLED" ? APPROVAL_STATUS.CANCELLED
          : APPROVAL_STATUS.APPROVED;
  } else if (mrf.status === "CANCELLED" && pending > 0) {
    status = APPROVAL_STATUS.CANCELLED;
  } else if (pending === total) {
    status = APPROVAL_STATUS.AWAITING_APPROVAL;
  } else if (pending > 0) {
    status = APPROVAL_STATUS.PARTIALLY_PROCESSED;
  } else if (approved === 0) {
    status = APPROVAL_STATUS.REJECTED;
  } else if (rejected > 0 || reduced > 0) {
    status = APPROVAL_STATUS.PARTIALLY_APPROVED;
  } else {
    status = APPROVAL_STATUS.APPROVED;
  }

  /* `awaiting` is what the manager can still act on — zero on a closed request
     even where lines were never decided. */
  const awaiting = CLOSED_REQUEST_STATES.has(mrf.status) ? 0 : pending;
  return { status, total, pending, awaiting, approved, rejected, reduced };
}

const approvalStatusOf = (mrf) => approvalSummary(mrf).status;

/** Human words for an approval status — the requester's and the manager's. */
const APPROVAL_STATUS_LABEL = Object.freeze({
  AWAITING_APPROVAL: "Awaiting approval",
  PARTIALLY_PROCESSED: "Partially processed",
  APPROVED: "Approved",
  PARTIALLY_APPROVED: "Partially approved",
  REJECTED: "Rejected",
  CANCELLED: "Withdrawn",
});

/* ══════════════════════════════════════════════════════════════════════════
 * Validating a set of decisions
 * ══════════════════════════════════════════════════════════════════════════ */

const asDecision = (v) => {
  const u = str(v).trim().toUpperCase();
  if (u === "APPROVED" || u === "APPROVE") return DECISION.APPROVED;
  if (u === "REJECTED" || u === "REJECT") return DECISION.REJECTED;
  return null;
};

const fmt = (qty, unit) => `${r4(qty)}${unit ? ` ${unit}` : ""}`;

/**
 * Check a manager's submission against the request as it is now.
 *
 * Accepts `[{ itemId, decision, approvedQty?, reason? }]`. Returns the
 * normalised list, or the FIRST problem — with the line it is about, so a
 * screen can put the message next to it.
 *
 * @returns {{ ok: true, decisions: object[] } |
 *           { ok: false, code: "VALIDATION"|"ALREADY_DECIDED", message: string, itemId?: string, field?: string }}
 */
function validateDecisions(mrf, input) {
  const bad = (message, extra = {}) => ({ ok: false, code: "VALIDATION", message, ...extra });
  if (!Array.isArray(input) || input.length === 0) {
    return bad("Choose Approve or Reject for at least one item before submitting.", { field: "decisions" });
  }

  const byId = new Map((mrf.items || []).map((l) => [idOf(l), l]));
  const seen = new Set();
  const out = [];

  for (const raw of input) {
    const itemId = str(raw && raw.itemId).trim();
    const line = byId.get(itemId);
    if (!itemId || !line) {
      return bad("One of the decisions names an item that is not on this request.", { itemId, field: "itemId" });
    }
    const name = line.rawItemName || "This item";
    if (seen.has(itemId)) {
      return bad(`"${name}" was decided twice in one submission.`, { itemId, field: "itemId" });
    }
    seen.add(itemId);

    const decision = asDecision(raw.decision);
    if (!decision) {
      return bad(`Choose Approve or Reject for "${name}".`, { itemId, field: "decision" });
    }

    const current = lineApproval(line, mrf);
    if (current.decision !== DECISION.PENDING) {
      return {
        ok: false,
        code: "ALREADY_DECIDED",
        message: `"${name}" was already ${current.decision === DECISION.APPROVED ? "approved" : "rejected"}`
          + `${current.decidedByName ? ` by ${current.decidedByName}` : ""} — a decision cannot be changed.`,
        itemId,
        field: "decision",
      };
    }

    const reason = str(raw.reason).trim();
    if (reason.length > REASON_MAX) {
      return bad(`Keep the reason for "${name}" under ${REASON_MAX} characters.`, { itemId, field: "reason" });
    }

    const requested = r4(line.requestedQty);
    if (decision === DECISION.REJECTED) {
      if (!reason) {
        return bad(`Give a reason for rejecting "${name}" — the requester sees it.`, { itemId, field: "reason" });
      }
      out.push({ itemId, decision, approvedQty: 0, rejectedQty: requested, requestedQty: requested, reason });
      continue;
    }

    let approvedQty = requested;
    if (raw.approvedQty !== undefined && raw.approvedQty !== null && raw.approvedQty !== "") {
      const q = Number(raw.approvedQty);
      if (!Number.isFinite(q)) {
        return bad(`Enter the quantity of "${name}" to approve as a number.`, { itemId, field: "approvedQty" });
      }
      if (q <= TOL) {
        return bad(`Approve more than 0 of "${name}", or reject it instead.`, { itemId, field: "approvedQty" });
      }
      if (q > requested + TOL) {
        return bad(
          `You can approve at most ${fmt(requested, line.unit)} of "${name}" — that is what was requested.`,
          { itemId, field: "approvedQty" },
        );
      }
      approvedQty = r4(q);
    }
    const rejectedQty = r4(Math.max(0, requested - approvedQty));
    if (rejectedQty > TOL && !reason) {
      return bad(
        `Say why only ${fmt(approvedQty, line.unit)} of ${fmt(requested, line.unit)} of "${name}" is approved — the requester sees it.`,
        { itemId, field: "reason" },
      );
    }
    out.push({ itemId, decision, approvedQty, rejectedQty, requestedQty: requested, reason });
  }

  return { ok: true, decisions: out };
}

/* ══════════════════════════════════════════════════════════════════════════
 * Applying them
 * ══════════════════════════════════════════════════════════════════════════ */

function pushEvent(mrf, ev) {
  if (typeof mrf.logEvent === "function") return mrf.logEvent(ev);
  mrf.statusHistory = mrf.statusHistory || [];
  mrf.statusHistory.push({ at: new Date(), ...ev });
  return mrf;
}

/**
 * Write every undecided line's PENDING record, so a request touched by
 * item-wise approval never mixes recorded lines with derived ones. Without
 * this, a still-waiting line on a request that has reached the store would
 * derive as "approved" from the request-level `tlApproved`.
 */
function materialisePending(mrf) {
  for (const line of mrf.items || []) {
    const a = line.approval;
    if (a && a.decision) continue;
    const derived = lineApproval(line, mrf);
    if (derived.decision !== DECISION.PENDING) continue;
    line.approval = { decision: DECISION.PENDING, requestedQty: r4(line.requestedQty) };
  }
}

/**
 * The Store's own status once no line waits on the manager any more.
 *
 * While a line waits, the request cannot be complete — that line may yet be
 * approved. When the last waiting line is REJECTED, the request may be done
 * after all: every line the store was given is issued, or the store had
 * already closed everything it was given as unfulfillable.
 */
function settleStoreStatus(mrf, now) {
  if (!["APPROVED", "PARTIALLY_ISSUED"].includes(mrf.status)) return;
  if ((mrf.items || []).some((l) => isAwaitingApproval(l, mrf))) return;

  const storeLines = (mrf.items || []).filter((l) => isWithStore(l, mrf));
  const live = storeLines.filter((l) => !["REJECTED", "UNFULFILLED"].includes(l.itemStatus));
  if (live.length === 0) {
    if (storeLines.some((l) => l.itemStatus === "UNFULFILLED")) {
      const anyIssued = (mrf.items || []).some((l) => (Number(l.issuedQty) || 0) > 0);
      mrf.status = anyIssued ? "PARTIALLY_ISSUED" : "UNFULFILLED";
      if (!mrf.unfulfilledAt) mrf.unfulfilledAt = now;
    }
    return;
  }
  if (live.every((l) => l.itemStatus === "ISSUED")) mrf.status = "ISSUED";
}

/**
 * Apply already-VALIDATED decisions to the request document.
 *
 * @param {object} mrf       mongoose document or plain object (tests)
 * @param {object[]} decisions  the `decisions` of a successful `validateDecisions`
 * @param {{ id?: any, name?: string, biometricId?: string }} actor
 * @returns {{ approved: object[], rejected: object[], handedToStore: boolean,
 *             fullyRejected: boolean, summary: object, previousStatus: string,
 *             previousApprovalStatus: string }}
 */
function applyDecisions(mrf, decisions, actor = {}, now = new Date()) {
  const previousStatus = mrf.status;
  const previousApprovalStatus = mrf.approvalStatus || approvalStatusOf(mrf);
  const actorName = str(actor.name);

  materialisePending(mrf);

  const byId = new Map((mrf.items || []).map((l) => [idOf(l), l]));
  const approved = [];
  const rejected = [];

  for (const d of decisions) {
    const line = byId.get(d.itemId);
    if (!line) continue;
    line.approval = {
      decision: d.decision,
      requestedQty: d.requestedQty,
      approvedQty: d.approvedQty,
      rejectedQty: d.rejectedQty,
      reason: d.reason || "",
      decidedBy: actor.id || null,
      decidedByName: actorName,
      decidedById: str(actor.biometricId),
      decidedAt: now,
    };

    if (d.decision === DECISION.APPROVED) {
      /* The Store issues against `requestedQty` — see the file header. */
      line.requestedQty = d.approvedQty;
      /* A line the requester typed rather than picked still has to be matched
         to the catalogue by the Store before it can be issued. */
      line.itemStatus = line.rawItem ? "APPROVED" : "UNMATCHED";
      approved.push(line);
      const qtyWords = d.rejectedQty > TOL
        ? `${fmt(d.approvedQty, line.unit)} of ${fmt(d.requestedQty, line.unit)} approved`
        : `${fmt(d.approvedQty, line.unit)} approved`;
      pushEvent(mrf, {
        action: "ITEM_APPROVED",
        actorName, actorRole: "tl",
        itemId: line._id,
        itemName: line.rawItemName,
        detail: `${line.rawItemName}: ${qtyWords} and sent to the Store.${d.reason ? ` Note: ${d.reason}` : ""}`,
      });
    } else {
      line.itemStatus = "REJECTED";
      rejected.push(line);
      pushEvent(mrf, {
        action: "ITEM_REJECTED",
        actorName, actorRole: "tl",
        itemId: line._id,
        itemName: line.rawItemName,
        detail: `${line.rawItemName}: ${fmt(d.requestedQty, line.unit)} rejected. Reason: ${d.reason}`,
      });
    }
  }

  const summary = approvalSummary(mrf);
  mrf.approvalStatus = summary.status;
  mrf.lastDecisionAt = now;

  /* ── THE FIRST APPROVED LINE TAKES THE REQUEST TO THE STORE ────────────── */
  let handedToStore = false;
  if (summary.approved > 0 && !mrf.tlApproved) {
    handedToStore = true;
    mrf.tlApproved = true;
    mrf.tlApprovedBy = actor.id || null;
    mrf.tlApprovedByName = actorName;
    mrf.tlApprovedAt = now;
    mrf.tlRejected = false;
    if (mrf.status === "PENDING") {
      mrf.status = "APPROVED";
      mrf.approvedAt = now;
    }
    pushEvent(mrf, {
      action: "TL_APPROVED",
      actorName, actorRole: "tl",
      detail: summary.awaiting
        ? `${summary.approved} of ${summary.total} item(s) approved and sent to the Store; ${summary.awaiting} still awaiting a decision.`
        : summary.rejected
          ? `${summary.approved} of ${summary.total} item(s) approved and sent to the Store; ${summary.rejected} rejected.`
          : "Approved and forwarded to the Store.",
    });
  }

  /* ── NOTHING APPROVED, NOTHING LEFT TO DECIDE: THE REQUEST IS REJECTED ─── */
  let fullyRejected = false;
  if (summary.approved === 0 && summary.pending === 0 && !CLOSED_REQUEST_STATES.has(mrf.status)) {
    fullyRejected = true;
    const reasons = [...new Set(
      (mrf.items || []).map((l) => lineApproval(l, mrf).reason).filter(Boolean),
    )];
    const note = reasons.join("; ").slice(0, 1000);
    mrf.tlRejected = true;
    mrf.tlRejectedBy = actor.id || null;
    mrf.tlRejectedByName = actorName;
    mrf.tlRejectedAt = now;
    mrf.tlRejectionNote = note;
    mrf.tlApproved = false;
    mrf.status = "REJECTED";
    mrf.rejectedAt = now;
    mrf.rejectionNote = note;
    pushEvent(mrf, { action: "TL_REJECTED", actorName, actorRole: "tl", detail: note });
  }

  settleStoreStatus(mrf, now);

  return {
    approved, rejected, handedToStore, fullyRejected,
    summary: approvalSummary(mrf),
    previousStatus, previousApprovalStatus,
  };
}

/* ══════════════════════════════════════════════════════════════════════════
 * Serialising for the screens
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * Stamp the derived decision onto every line of a plain (lean / toObject)
 * request, plus the request's approval summary — so the three frontends read
 * one answer instead of deriving their own. Mutates and returns `mrf`.
 */
function annotate(mrf) {
  if (!mrf || !Array.isArray(mrf.items)) return mrf;
  for (const line of mrf.items) {
    const a = lineApproval(line, mrf);
    line.approval = {
      ...(line.approval || {}),
      decision: a.decision,
      requestedQty: a.requestedQty,
      approvedQty: a.approvedQty,
      rejectedQty: a.rejectedQty,
      reason: a.reason,
      decidedByName: a.decidedByName,
      decidedById: a.decidedById,
      decidedAt: a.decidedAt,
      automatic: a.automatic,
    };
    line.awaitingApproval = isAwaitingApproval(line, mrf);
    line.withStore = a.decision === DECISION.APPROVED;
  }
  const s = approvalSummary(mrf);
  mrf.approvalStatus = s.status;
  mrf.approvalStatusLabel = APPROVAL_STATUS_LABEL[s.status];
  mrf.approvalCounts = {
    total: s.total, awaiting: s.awaiting, approved: s.approved, rejected: s.rejected, reduced: s.reduced,
  };
  return mrf;
}

/**
 * A Mongo `$match` fragment selecting requests whose approval status is one of
 * `statuses` — including old requests that have no stored `approvalStatus`,
 * classified the way `approvalSummary` classifies them from their `status`.
 */
function approvalStatusMatch(statuses) {
  const want = new Set(statuses);
  const legacy = [];
  if (want.has(APPROVAL_STATUS.AWAITING_APPROVAL)) legacy.push({ status: "PENDING" });
  if (want.has(APPROVAL_STATUS.REJECTED)) legacy.push({ status: "REJECTED" });
  if (want.has(APPROVAL_STATUS.CANCELLED)) legacy.push({ status: "CANCELLED", tlApproved: { $ne: true } });
  if (want.has(APPROVAL_STATUS.APPROVED)) {
    legacy.push({ status: { $nin: ["PENDING", "REJECTED", "CANCELLED"] } });
    legacy.push({ status: "CANCELLED", tlApproved: true });
  }
  const noStored = { $or: [{ approvalStatus: { $exists: false } }, { approvalStatus: null }] };
  return {
    $or: [
      { approvalStatus: { $in: [...want] } },
      ...(legacy.length ? [{ $and: [noStored, { $or: legacy }] }] : []),
    ],
  };
}

/**
 * The same classification as an aggregation expression, for counting a
 * queue in one `$group` — stored value first, the `status` fallback for old
 * requests.
 */
const approvalStatusExpr = () => ({
  $ifNull: [
    "$approvalStatus",
    {
      $switch: {
        branches: [
          { case: { $eq: ["$status", "PENDING"] }, then: APPROVAL_STATUS.AWAITING_APPROVAL },
          { case: { $eq: ["$status", "REJECTED"] }, then: APPROVAL_STATUS.REJECTED },
          {
            case: { $and: [{ $eq: ["$status", "CANCELLED"] }, { $ne: ["$tlApproved", true] }] },
            then: APPROVAL_STATUS.CANCELLED,
          },
        ],
        default: APPROVAL_STATUS.APPROVED,
      },
    },
  ],
});

module.exports = {
  DECISION,
  APPROVAL_STATUS,
  APPROVAL_STATUS_LABEL,
  AWAITING_STATUSES,
  CLOSED_REQUEST_STATES,
  REASON_MAX,
  lineApproval,
  isAwaitingApproval,
  isWithStore,
  awaitingLineIds,
  approvalSummary,
  approvalStatusOf,
  validateDecisions,
  applyDecisions,
  materialisePending,
  settleStoreStatus,
  annotate,
  approvalStatusMatch,
  approvalStatusExpr,
};

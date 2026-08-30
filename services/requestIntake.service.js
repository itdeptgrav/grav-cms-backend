/**
 * services/requestIntake.service.js
 *
 * ONE DOOR IN, FOUR WAYS OUT.
 *
 * ── THE PROBLEM THIS SOLVES ─────────────────────────────────────────────────
 * The Requests app used to open on a question the requester cannot answer:
 * is this Material from Store, or a Purchase, or a Service, or a Recurring
 * spend? Somebody who needs a replacement blade does not know whether the
 * store holds one. Somebody who needs the compressor looked at does not know
 * whether that is a service contract or a purchase order. Asking them to pick
 * is asking them to model the company's fulfilment before they may ask for
 * anything, and the cost of a wrong guess lands on them: the request goes to
 * the wrong desk and comes back.
 *
 * Three people know three different pieces of it:
 *
 *   the requester    what they need, and why
 *   store/purchase   whether stock exists or it has to be bought
 *   finance          whether the money may be spent, and against what head
 *
 * So the intake collects only the first, and the other two are asked later, of
 * the people who can actually answer them.
 *
 * ── WHAT DOES NOT CHANGE ────────────────────────────────────────────────────
 * The fulfilment paths themselves. A classified store request BECOMES an MRF —
 * the same document, the same store screens, the same issue and return. A
 * classified purchase BECOMES a SpendRequest — the same finance approval, the
 * same budget commitment, the same purchasing queue. This layer decides which
 * of them a request is; it does not reimplement either.
 *
 * ── WHY THE TL STEP IS FIRST AND NOT LAST ───────────────────────────────────
 * "Does this department actually need this" is answerable without knowing how
 * it will be fulfilled, and it is the cheapest question to ask: most requests
 * that should stop, stop there. Classifying first would mean store spending
 * time on asks the TL was going to refuse.
 */

"use strict";

/* The one rule about whose approval a request waits for. Shared with the
   spend chain and with MRF so three collections cannot answer it
   differently — see services/tlRouting.service.js. */
const tlRouting = require("./tlRouting.service");
/* The department-bound chain. A request walks up the reporting line and stops
   at the edge of the requester's own department — see approvalChain.service. */
const approvalChain = require("./approvalChain.service");

/* ── WHERE A REQUEST SITS ────────────────────────────────────────────────────
 * One field. Two fields that can disagree eventually do, and then no screen
 * knows which to believe.
 *
 * After classification the request is a POINTER: the live state is the MRF's
 * or the spend request's, and `stageLabel` reads it from there rather than
 * keeping a second copy that drifts. What stays here is which door it went
 * out of, which is a fact about this request and nobody else's to change. */
const DRAFT = "draft";
const PENDING_TL = "pending_tl";
const NEEDS_CLASSIFICATION = "needs_classification";
const STORE_ISSUE = "store_issue";
const PURCHASE_REQUIRED = "purchase_required";
const SERVICE_REQUIRED = "service_required";
const RECURRING_REQUIRED = "recurring_required";
const REJECTED = "rejected";
const CANCELLED = "cancelled";
const CLOSED = "closed";

const STATUSES = [
  DRAFT,
  PENDING_TL,
  NEEDS_CLASSIFICATION,
  STORE_ISSUE,
  PURCHASE_REQUIRED,
  SERVICE_REQUIRED,
  RECURRING_REQUIRED,
  REJECTED,
  CANCELLED,
  CLOSED,
];

/** Still an ask — nothing has been fulfilled and the requester may withdraw. */
const OPEN_STATUSES = [PENDING_TL, NEEDS_CLASSIFICATION];

/** Classified, and living in another collection from here on. */
const CLASSIFIED_STATUSES = [
  STORE_ISSUE,
  PURCHASE_REQUIRED,
  SERVICE_REQUIRED,
  RECURRING_REQUIRED,
];

/* ── THE FOUR WAYS OUT ───────────────────────────────────────────────────────
 * `kind` is what a fulfiller chooses; `status` is where that leaves the
 * request. They are separate names because the choice is a verb and the status
 * is a place, and collapsing them would make "the request is a purchase" and
 * "somebody decided it is a purchase" the same sentence.
 *
 * `needsFinance` is the whole point of the distinction. Issuing stock the
 * company already owns spends nothing — there is no money question, so there
 * is no finance step and inventing one would only add a week to handing
 * somebody a box of blades. Everything else leaves the company's bank account
 * and finance decides. */
const KINDS = Object.freeze({
  store_issue: {
    id: "store_issue",
    label: "From store stock",
    status: STORE_ISSUE,
    needsFinance: false,
    /** Which collection the request becomes on classification. */
    becomes: "mrf",
  },
  purchase: {
    id: "purchase",
    label: "Buy from outside",
    status: PURCHASE_REQUIRED,
    needsFinance: true,
    becomes: "spend",
    /** What the spawned spend request is raised as. */
    spendType: "PRODUCT",
  },
  service: {
    id: "service",
    label: "Service or repair",
    status: SERVICE_REQUIRED,
    needsFinance: true,
    becomes: "spend",
    spendType: "SERVICE",
  },
  /* ── PART OF IT IS ON THE SHELF ─────────────────────────────────────────
     The one route that produces TWO documents: an MRF for what the store can
     issue today, and a spend request for the balance. It exists because the
     honest answer to "do you have twenty of these" is often "I have eight",
     and the two routes that existed before forced that into a lie — either
     issue eight and lose the other twelve, or buy all twenty while eight sit
     on the shelf.

     Its status is PURCHASE_REQUIRED rather than a new one: the part that
     decides when the request is finished is the part somebody still has to
     approve money for, and every queue, label and count already understands
     that status. The MRF half is not waiting on anybody. */
  partial: {
    id: "partial",
    label: "Partly issue, buy the balance",
    status: PURCHASE_REQUIRED,
    needsFinance: true,
    becomes: "both",
    spendType: "PRODUCT",
  },
  recurring: {
    id: "recurring",
    label: "Recurring spend",
    status: RECURRING_REQUIRED,
    needsFinance: true,
    becomes: "spend",
    spendType: "SERVICE",
    /** A schedule has to be captured before finance can agree to it. */
    needsSchedule: true,
  },
});

const KIND_IDS = Object.keys(KINDS);

/** How often a recurring spend comes back. Captured, never generated — see the model. */
const FREQUENCIES = ["MONTHLY", "QUARTERLY", "HALF_YEARLY", "YEARLY"];

const FREQUENCY_LABEL = {
  MONTHLY: "Every month",
  QUARTERLY: "Every quarter",
  HALF_YEARLY: "Every six months",
  YEARLY: "Every year",
};

/* ── WHAT EACH STATE IS CALLED ───────────────────────────────────────────────
 * Written for the person who raised it. Not one of these says STORE_ISSUE,
 * PURCHASE or SpendRequest: those are how the company is built, and somebody
 * asking for a replacement blade should not have to learn the plumbing to read
 * where their request got to. */
const STAGE_LABEL = {
  [DRAFT]: "Draft",
  [PENDING_TL]: "Waiting for department approval",
  [NEEDS_CLASSIFICATION]: "With Store for fulfilment",
  [STORE_ISSUE]: "Ready for store",
  [PURCHASE_REQUIRED]: "Waiting for finance",
  [SERVICE_REQUIRED]: "Waiting for finance",
  [RECURRING_REQUIRED]: "Waiting for finance",
  [REJECTED]: "Rejected",
  [CANCELLED]: "Withdrawn",
  [CLOSED]: "Closed",
};

/* ── AND WHAT THE THINGS IT BECAME ARE CALLED ────────────────────────────────
 * Once a request is classified its live state lives on the MRF or the spend
 * request, and the desk has to say something about it in the same vocabulary
 * as the rows beside it.
 *
 * The spend side needs no map: spendApproval.STAGE_LABEL is already written in
 * these words and is shared rather than copied. The store side does, because
 * MRF's own labels are composed inside its router for its own screens and
 * are not exported — and because "PARTIALLY_ISSUED" is a state of a stock
 * issue, not a sentence for the person who asked for a box of blades. */
const MRF_STAGE_LABEL = {
  PENDING: "Waiting for manager",
  APPROVED: "Ready for store",
  PARTIALLY_ISSUED: "Partly issued",
  ISSUED: "Issued",
  PARTIALLY_RETURNED: "Partly returned",
  COMPLETED: "Closed",
  REJECTED: "Rejected",
  UNFULFILLED: "Store cannot supply it",
  CANCELLED: "Withdrawn",
};

/* The states in which nothing further is going to happen. Used to sort a desk
   so the things somebody can act on are not buried under a year of closed
   ones — never to hide a row. */
const SETTLED_MRF = ["COMPLETED", "REJECTED", "UNFULFILLED", "CANCELLED"];

/* ── WHAT KIND OF THING IS BEING ASKED FOR ───────────────────────────────────
 * Two, and only ever two. This is the ONE classification the requester can
 * actually make — they know whether they need a thing or need something done —
 * and it is a different question from how it gets fulfilled, which is Store's.
 *
 * ── WHY THERE IS NO "SOFTWARE" ──────────────────────────────────────────────
 * It never described a different KIND of ask. A subscription is work and access
 * bought from a vendor, which is what SERVICE already means, so a third option
 * only asked people to draw a line that does not exist — is a hosted design
 * tool software, or a service? Repairs, AMCs, audits, installation, consulting
 * and subscriptions are all one answer. Two categories somebody can separate
 * without thinking beat three that invite a pause.
 *
 * The same reasoning, and the same two values, as SpendRequest's own enum — so
 * a request becoming a spend request carries its type across rather than being
 * re-decided by a mapping table. */
const REQUEST_TYPES = ["PRODUCT", "SERVICE"];

const REQUEST_TYPE_LABEL = {
  PRODUCT: "Product",
  SERVICE: "Service",
};

/** What each is, in the words the form uses. */
const REQUEST_TYPE_HINT = {
  PRODUCT: "Physical item or material. Store may issue from stock or purchase it.",
  SERVICE: "Repair, software, subscription, installation, audit, AMC or outside work.",
};

const PRIORITIES = ["NORMAL", "HIGH", "URGENT"];

/**
 * Where a new request starts.
 *
 * ── WHAT REPLACED "DO THEY MANAGE ANYBODY" ──────────────────────────────────
 * The old rule sent a request straight past approval if the raiser managed
 * SOMEBODY — anybody, anywhere. That is not the question. A team lead with two
 * reports still has a department head above them, and their spending is
 * exactly what that head is there to see.
 *
 * The question is whether anybody stands above them INSIDE THEIR OWN
 * DEPARTMENT. Rakesh, who runs IT and reports to a CEO outside it, genuinely
 * has nobody — so his request skips department approval and goes to Store.
 * Pramod, who reports to Rakesh, does not.
 *
 * An empty chain is therefore an answer rather than a failure, and the two
 * reasons for one — nobody senior, or a reporting line that could not be
 * walked — are told apart by `chainStop` on the request.
 */
function startingStatus({ chainLength = 0 } = {}) {
  return chainLength > 0 ? PENDING_TL : NEEDS_CLASSIFICATION;
}


/**
 * What this person may do to this request at the department step.
 *
 * ── TWO SHAPES, ONE DOOR ────────────────────────────────────────────────────
 * A request raised since the chain existed carries one, and the chain is the
 * whole answer: only the approver whose TURN it is may act, so nobody skips a
 * step the department decided to have.
 *
 * A request raised before it carries a single stored approver instead. Those
 * are still live and still somebody's to answer, so they fall through to the
 * old rule rather than being stranded — see tlRouting.service. Nothing was
 * migrated; the shape of the row decides which rule reads it.
 */
function decisionFor({ request, viewer }) {
  const status = String(request?.status || "");
  const no = (reason) => ({ can: false, step: null, reason });

  if (status !== PENDING_TL) {
    return no(`This request is ${STAGE_LABEL[status] || status}.`);
  }

  if ((request?.approvalChain || []).length) {
    const verdict = approvalChain.chainEntitlement({ request, viewer });
    return verdict.can
      ? { can: true, step: "tl", via: "chain", reason: null }
      : no(verdict.reason);
  }

  /* Raised before the chain existed. One rule, three collections — it refuses
     the requester first, which is why a lead's own request never lands here
     for them to wave through. */
  const verdict = tlRouting.tlEntitlement({ request, viewer });
  return verdict.can
    ? { can: true, step: "tl", via: verdict.via, reason: null }
    : no(verdict.reason);
}


/**
 * May this person classify this request, and into what?
 *
 * Classification is not an approval — nobody is agreeing to anything here, they
 * are answering "how does this get fulfilled". So it is open to whoever runs
 * fulfilment (store and purchase) and to finance, who sees every request
 * anyway. It is deliberately NOT open to the requester: the whole point of the
 * unified intake is that they were never asked to know this.
 */
function classificationFor({ request, viewer }) {
  const status = String(request?.status || "");
  const no = (reason) => ({ can: false, reason });

  if (status !== NEEDS_CLASSIFICATION) {
    if (CLASSIFIED_STATUSES.includes(status)) {
      return no("This request has already been classified.");
    }
    return no(`This request is ${STAGE_LABEL[status] || status}.`);
  }
  if (!viewer?.canFulfil) {
    return no("Only Store & Purchase or finance can decide how a request is fulfilled.");
  }
  return { can: true, reason: null };
}

/** The kind, or null if it is not one of the four. */
function kindOf(id) {
  return KINDS[String(id || "").toLowerCase()] || null;
}

/** Does this way out need finance to agree before anything is ordered? */
function needsFinance(id) {
  return Boolean(kindOf(id)?.needsFinance);
}

/**
 * Is this request ready for the manager to approve?
 *
 * ── WHY THE HEAD IS CHOSEN HERE AND NOT BY THE REQUESTER ────────────────────
 * A person who needs a replacement blade knows what they need; they do not know
 * which head finance books it against, and asking them produced either a guess
 * or a shrug. Their manager DOES know — it is their department's budget, and
 * they are already reading the request to decide whether the department needs
 * it at all. One person, one screen, both questions.
 *
 * ── AND WHY IT IS REQUIRED EVEN FOR SOMETHING THE STORE MIGHT HAVE ──────────
 * Because nobody knows yet. A Product may come off a shelf and cost nothing, or
 * be bought and cost money, and that is Store's call at the next step — by which
 * point the manager has moved on. Asking for the head once, from the person who
 * knows it, beats sending the request back up the chain when Store discovers it
 * has to be bought. Where the store does fill it from stock, the head is simply
 * recorded and never used.
 *
 * A department with nothing approved is not stuck: they may ask for a head in
 * words, which reaches finance marked as such.
 */
function readyToApprove({ ledgerId, unbudgetedHead, requestedHeadName, requestedHeadReason }) {
  if (unbudgetedHead === true) {
    if (!String(requestedHeadName || "").trim()) {
      return { ok: false, reason: "Name the budget head this should be charged to." };
    }
    if (!String(requestedHeadReason || "").trim()) {
      return { ok: false, reason: "Say why none of the department's approved heads fit." };
    }
    return { ok: true, reason: null };
  }
  if (!ledgerId) {
    return {
      ok: false,
      reason:
        "Choose the budget head this belongs to, or ask for a new one — finance cannot review a request without one.",
    };
  }
  return { ok: true, reason: null };
}

/**
 * Is this request ready to be classified into `kind`?
 *
 * The head is NOT asked for here any more — the manager chose it at approval,
 * and Store sees it read-only. What is checked is that one is actually there:
 * a request that reached this desk without a head cannot become a spend request,
 * and letting Store invent one would put the choice back with the person who
 * knows the department's budget least.
 *
 * `hasApprovedHead` is the request's own state, passed in rather than read, so
 * this stays a pure rule.
 */
function readyToClassify({ kind, hasApprovedHead, schedule }) {
  const k = kindOf(kind);
  if (!k) return { ok: false, reason: "That is not a way a request can be fulfilled." };

  if (k.needsFinance && !hasApprovedHead) {
    return {
      ok: false,
      reason:
        "This one spends money and no budget head was set when it was approved. Send it back to the requester's manager to choose one.",
    };
  }

  if (k.needsSchedule) {
    const freq = String(schedule?.frequency || "").toUpperCase();
    if (!FREQUENCIES.includes(freq)) {
      return { ok: false, reason: "Say how often this repeats." };
    }
  }

  return { ok: true, reason: null };
}

module.exports = {
  DRAFT,
  PENDING_TL,
  NEEDS_CLASSIFICATION,
  STORE_ISSUE,
  PURCHASE_REQUIRED,
  SERVICE_REQUIRED,
  RECURRING_REQUIRED,
  REJECTED,
  CANCELLED,
  CLOSED,
  STATUSES,
  OPEN_STATUSES,
  CLASSIFIED_STATUSES,
  KINDS,
  KIND_IDS,
  FREQUENCIES,
  FREQUENCY_LABEL,
  REQUEST_TYPES,
  REQUEST_TYPE_LABEL,
  REQUEST_TYPE_HINT,
  STAGE_LABEL,
  MRF_STAGE_LABEL,
  SETTLED_MRF,
  PRIORITIES,
  startingStatus,
  decisionFor,
  tlRouting,
  approvalChain,
  classificationFor,
  kindOf,
  needsFinance,
  readyToApprove,
  readyToClassify,
};

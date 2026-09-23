// services/marketing/handoverReadModel.service.js
//
// WHAT A MARKETER SEES ON /marketing/handovers, ASSEMBLED FROM MARKETING'S OWN
// RECORDS.
//
// ── WHY A SERVICE AND NOT TWO FATTER ROUTES ────────────────────────────────
// The page asks six questions — what did we send, did it reach Sales, what did
// Sales say, how long did that take, did acquisition actually stop, and which
// Sales record does the answer point at — and every one of them is an
// interpretation of stored facts rather than a field. Interpretation in a route
// handler is interpretation that cannot be tested without HTTP, cannot be
// reused by the detail view, and drifts between the two the first time one is
// edited. So the list and the detail read the SAME functions here, and the
// routes do authentication, validation of what the caller asked for, and
// serialisation.
//
// ── AND IT READS NOTHING SALES OWNS ────────────────────────────────────────
// Marketing's answer to "what did Sales decide" comes from
// `ProspectHandover.outcome`, which `salesOutcomeIntake` writes from a DELIVERED
// outcome event. That is the contract: Sales announces, Marketing records, and
// Marketing reads its own record afterwards. This file therefore imports no
// Sales model at all — not the Lead, not the Sales-side handover receipt — and
// `test/marketing/handover-read-model.test.js` asserts that structurally,
// because the tempting shortcut here is one `Lead.findById` for a display name.
//
// The canonical Sales record appears as IDENTITY ONLY: a type, an id and a
// reference. The frontend builds its own internal route from those. Copying a
// name or a status into this payload would create a second, stale answer to a
// question Sales already answers.
//
// ── WHAT IT REFUSES TO INVENT ──────────────────────────────────────────────
// No "overdue". `recommendedAction` is a suggestion written for a salesperson,
// not a service-level agreement, and turning an elapsed duration into a breach
// would manufacture an obligation nobody agreed to. Durations are reported as
// data and the reader decides.
//
// No `paused` boolean. Chunk 3B established four separate facts — currently
// removed, future enrolment prevented, awaiting retry, confirmed stopped — and
// collapsing them is how the original lie got told.
//
// No zero standing in for a failed read. A count here is a measured count or
// the request fails.
"use strict";

const Handover = require("../../models/CMS_Models/Marketing/ProspectHandover");
const { MarketingAuditEvent, MarketingOutboxEvent } = require("../../models/CMS_Models/Marketing/MarketingEvent");
const acquisitionHold = require("./acquisitionHold.service");
const { fail } = require("../storePurchase/errors");
const {
  HANDOVER_STATE_CODES, MARKETING_EVENT_KINDS, ACQUISITION_HOLD_REASON_CODES,
} = require("../../constants/marketing");

const str = (v) => String(v ?? "").trim();

/* ── WHAT A CALLER MAY ASK FOR ──────────────────────────────────────────────
   A closed list. An unrecognised filter is REFUSED rather than answered with an
   empty page: an empty page is indistinguishable from "there are none", so a
   typo in a query string would read as a truthful report that Sales has nothing
   waiting. */
const LIST_FILTERS = Object.freeze(["all", ...HANDOVER_STATE_CODES]);

const MAX_PAGE = 100;
const DEFAULT_PAGE = 25;

/* ═══ TIMESTAMPS, TREATED AS UNTRUSTWORTHY ═════════════════════════════════

   Every duration in this payload is a subtraction of two stored values, and a
   stored value can be absent, a string nothing parsed, or a date somebody wrote
   in the wrong order. The arithmetic must therefore never be performed on faith:
   a reversed pair would produce a negative duration, and clamping that to zero
   would turn a data fault into the cheerful claim that Sales answered instantly.
   Both are reported as UNAVAILABLE instead. */

/** A real Date, or null for anything that is not one. */
function validDate(v) {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  const t = d.getTime();
  return Number.isFinite(t) ? d : null;
}

/** The shape every unmeasured duration takes, so a reader never has to branch. */
function notMeasured(reason, basis = "unavailable") {
  return {
    available: false, basis, reason, elapsedMs: null, elapsedHours: null, from: null, to: null,
  };
}

/**
 * The elapsed time between two instants, or an honest refusal.
 *
 * `from` is also passed as `whenFromPresent` so a missing start and a missing end
 * can be told apart in the reason a reader is shown.
 */
function elapsedBetween(from, to, basis, missingEndReason) {
  if (!from) return notMeasured("No start time is recorded, so this cannot be measured.");
  if (!to) return notMeasured(missingEndReason);

  const elapsedMs = to.getTime() - from.getTime();
  if (!Number.isFinite(elapsedMs)) {
    return notMeasured("The recorded times do not produce a measurable duration.");
  }
  if (elapsedMs < 0) {
    /* Reversed, not zero. A negative duration means the records disagree about
       the order of events, which is a fault worth seeing rather than rounding
       away. */
    return notMeasured("The recorded times are in the wrong order, so the duration is not measurable.");
  }
  return {
    available: true,
    basis,
    reason: "",
    elapsedMs,
    elapsedHours: Math.round((elapsedMs / 3_600_000) * 10) / 10,
    from,
    to,
  };
}

/* ═══ DELIVERY TO SALES ════════════════════════════════════════════════════

   Four different situations that a single "sent" flag would have flattened.
   The one that matters most is the third: a handover sitting in Marketing's
   outbox has NOT reached Sales, and calling that "awaiting review" would tell a
   marketer that Sales is slow when the truth is that Sales has never seen it. */
const DELIVERY = Object.freeze({
  BLOCKED: {
    state: "BLOCKED_BEFORE_SUBMISSION",
    label: "Blocked in Marketing — never submitted to Sales.",
  },
  PENDING: {
    state: "PENDING_DELIVERY",
    label: "Waiting to be delivered to Sales. Sales has not seen it yet.",
  },
  RETRYING: {
    state: "DELIVERY_FAILED",
    label: "Delivery to Sales failed and is awaiting another attempt.",
  },
  DELIVERED: {
    state: "DELIVERED",
    label: "Delivered to Sales.",
  },
  UNRECORDED: {
    state: "UNRECORDED",
    label: "No delivery record exists for this handover. It needs an operator.",
  },
});

/**
 * How far this handover got towards Sales.
 *
 * Never carries the stored `lastError`. That string is whatever an exception
 * said, and an exception is free to quote a provider body or a connection
 * string; the state and the attempt count are what a marketer can act on, and a
 * bounded fixed sentence is what they read.
 */
function deliveryOf(handover, outboxEvent, measuredAt) {
  if (handover.state === "BLOCKED") {
    return {
      ...DELIVERY.BLOCKED,
      submittedAt: null,
      deliveredAt: null,
      attempts: 0,
      lastAttemptAt: null,
      blockedReason: str(handover.blockedReason),
      waitingForDelivery: notMeasured("This handover was never submitted, so nothing is waiting to be delivered."),
    };
  }

  const submittedAt = validDate(handover.submittedAt);

  if (!outboxEvent) {
    return {
      ...DELIVERY.UNRECORDED,
      submittedAt: handover.submittedAt || null,
      deliveredAt: null,
      attempts: 0,
      lastAttemptAt: null,
      blockedReason: "",
      waitingForDelivery: notMeasured("No delivery record exists, so the wait cannot be measured."),
    };
  }

  const attempts = Number(outboxEvent.attempts) || 0;
  const delivered = outboxEvent.status === "DELIVERED";
  /* A failed attempt is a PENDING row that has been tried. The distinction is
     the whole point: "not yet sent" and "sent, refused, will be tried again"
     are different things to a person deciding whether to chase Sales. */
  const shape = delivered ? DELIVERY.DELIVERED : (attempts > 0 ? DELIVERY.RETRYING : DELIVERY.PENDING);
  const deliveredAt = delivered ? validDate(outboxEvent.deliveredAt) : null;

  return {
    ...shape,
    submittedAt: handover.submittedAt || outboxEvent.occurredAt || null,
    deliveredAt: deliveredAt || null,
    attempts,
    lastAttemptAt: outboxEvent.lastAttemptAt || null,
    blockedReason: "",
    /* ── HOW LONG THE HANDOVER SPENT IN MARKETING'S OUTBOX ───────────────
       Submission to delivery, or submission to now while it is still waiting.
       Deliberately here rather than beside the Sales response time, and
       deliberately named for what it is: this is GRAV waiting on its own
       delivery mechanism, and calling it a Sales response time was the whole
       bug this correction removes. */
    waitingForDelivery: elapsedBetween(
      submittedAt,
      delivered ? deliveredAt : measuredAt,
      delivered ? "delivered" : "waiting",
      submittedAt
        ? "The delivery record has no confirmed delivery time."
        : "This handover has no recorded submission time.",
    ),
  };
}

/* ═══ HOW LONG SALES TOOK, OR HAS BEEN TAKING ══════════════════════════════

   ── THE BUG THIS REPLACES ─────────────────────────────────────────────────
   The first version measured from `submittedAt`, which is when MARKETING
   committed the handover — not when Sales received it. A handover sitting in
   Marketing's own outbox therefore accumulated an "awaiting" Sales-response
   duration that grew by the hour while Sales had never been shown it. The page
   would have told a marketer that Sales had been sitting on something for two
   days when the truth was that GRAV had never delivered it, which points the
   blame in precisely the wrong direction and hides the real fault.

   A Sales response time is therefore measured from CONFIRMED DELIVERY and from
   nothing else. Until delivery is confirmed there is no such duration to report,
   and the payload says so rather than substituting one. The time spent waiting
   for delivery is still measured — it is just reported under `delivery`, where
   it belongs, and named for what it is. */
const TIMING_BASIS = Object.freeze({
  BLOCKED: "blocked",
  DELIVERY_UNCONFIRMED: "delivery_unconfirmed",
  AWAITING: "awaiting",
  DECIDED: "decided",
  UNAVAILABLE: "unavailable",
});

/**
 * Elapsed Sales-response time, from recorded timestamps only.
 *
 * `applicable` false means the question does not arise: a blocked handover was
 * never put to Sales, so there is no response to time, ever. `available` false
 * means it does arise and cannot be measured yet or at all — delivery is not
 * confirmed, or a timestamp is missing, unparseable or out of order.
 *
 * There is deliberately no status beyond those flags and a basis. A duration is
 * data; whether it is too long is a judgement this slice does not make.
 *
 * @param {object} handover
 * @param {object} delivery  the presentation from `deliveryOf`, so the two
 *   cannot disagree about whether delivery happened.
 * @param {Date} measuredAt
 */
function responseTimingOf(handover, delivery, measuredAt) {
  if (handover.state === "BLOCKED") {
    return {
      applicable: false,
      ...notMeasured(
        "This handover was blocked in Marketing, so Sales was never asked.",
        TIMING_BASIS.BLOCKED,
      ),
    };
  }

  /* ── NOT DELIVERED MEANS NOT YET A SALES RESPONSE TIME ────────────────────
     Pending, failed and unrecorded all land here. The wait is real and is
     reported under `delivery.waitingForDelivery`; what is absent is any claim
     about how long SALES has taken. */
  if (delivery.state !== DELIVERY.DELIVERED.state) {
    return {
      applicable: true,
      ...notMeasured(
        "Delivery to Sales has not been confirmed, so there is no Sales response time to measure yet.",
        TIMING_BASIS.DELIVERY_UNCONFIRMED,
      ),
    };
  }

  const deliveredAt = validDate(delivery.deliveredAt);
  if (!deliveredAt) {
    return {
      applicable: true,
      ...notMeasured(
        "This handover is marked delivered with no recorded delivery time, so its response time cannot be measured.",
        TIMING_BASIS.UNAVAILABLE,
      ),
    };
  }

  const decided = Boolean(str(handover.outcome?.decision));
  if (!decided) {
    /* Growing with the clock, and only true as of `measuredAt` — which every
       payload carries for exactly this reason. */
    return {
      applicable: true,
      ...elapsedBetween(deliveredAt, validDate(measuredAt), TIMING_BASIS.AWAITING,
        "The moment of measurement is not a valid time."),
    };
  }

  const decidedAt = validDate(handover.outcome?.decidedAt);
  if (!decidedAt) {
    return {
      applicable: true,
      ...notMeasured(
        "This handover carries a decision with no recorded decision time.",
        TIMING_BASIS.UNAVAILABLE,
      ),
    };
  }

  return {
    applicable: true,
    ...elapsedBetween(deliveredAt, decidedAt, TIMING_BASIS.DECIDED,
      "The decision has no recorded time."),
  };
}

/* ═══ ACQUISITION ══════════════════════════════════════════════════════════ */

/* Which decisions owe an acquisition stop at all. Read from the hold service so
   the list cannot disagree with the thing that carries the stop out. */
const HOLD_WORTHY = new Set(Object.keys(acquisitionHold.HOLD_REASON_FOR_DECISION));

/**
 * What actually happened to this person's acquisition messaging.
 *
 * The four disclosure facts travel intact. `retryIsAutomatic` is false because
 * this deployment has no scheduler, and it is reported rather than assumed so a
 * screen cannot imply that a failed stop will fix itself.
 */
function acquisitionOf(handover, hold) {
  const decision = str(handover.outcome?.decision);

  if (!decision || !HOLD_WORTHY.has(decision)) {
    return {
      applicable: false,
      state: "NOT_APPLICABLE",
      label: decision
        ? `A ${decision.toLowerCase().replace("_", " ")} decision does not stop acquisition messaging.`
        : "No Sales decision yet, so no acquisition stop is owed.",
      pausedAt: null,
      requestedAt: null,
      attempts: 0,
      lastAttemptAt: null,
      nextAttemptAt: null,
      failure: null,
      supersededBy: null,
      disclosure: acquisitionHold.disclosure(null),
    };
  }

  if (!hold) {
    /* The decision owes a stop and no command exists. Chunk 3B's reconciliation
       repairs this on the next delivery or replay; until then it is a real and
       visible gap, not an absence to render as blank. */
    return {
      applicable: true,
      state: "MISSING",
      label: "This decision owes an acquisition stop and no command has been raised. It needs an operator.",
      pausedAt: null,
      requestedAt: null,
      attempts: 0,
      lastAttemptAt: null,
      nextAttemptAt: null,
      failure: null,
      supersededBy: null,
      disclosure: acquisitionHold.disclosure(null),
    };
  }

  return {
    applicable: true,
    state: hold.state,
    label: hold.label,
    pausedAt: hold.pausedAt,
    requestedAt: hold.requestedAt,
    reason: hold.reason,
    attempts: hold.attempts,
    lastAttemptAt: hold.lastAttemptAt,
    nextAttemptAt: hold.nextAttemptAt,
    failure: hold.failure,
    supersededBy: hold.supersededBy,
    disclosure: hold.disclosure,
  };
}

/* ═══ ONE ROW ══════════════════════════════════════════════════════════════ */

/**
 * The operational fields the page needs, and nothing else.
 *
 * Built by naming each field rather than by spreading the document and deleting:
 * a field added to `ProspectHandover` next month must not appear on this
 * payload because somebody forgot to exclude it.
 */
function rowOf(handover, { outboxEvent = null, hold = null, measuredAt }) {
  const outcome = handover.outcome || {};
  const decided = Boolean(str(outcome.decision));
  const person = handover.person || {};
  const displayName = [str(person.firstName), str(person.lastName)].filter(Boolean).join(" ");

  /* Built once and handed to the timing function, so the delivery state the row
     shows and the delivery state the timing depends on are the same value. */
  const delivery = deliveryOf(handover, outboxEvent, measuredAt);

  return {
    handoverRef: handover.handoverRef,
    submittedAt: handover.submittedAt || null,
    createdAt: handover.createdAt || null,
    state: handover.state,

    person: {
      /* A display name, not the raw parts: the page shows one string, and
         assembling it here keeps every surface assembling it the same way. */
      displayName: displayName || "(name not captured)",
      jobTitle: str(person.jobTitle),
      /* WORK email only. `ProspectHandover` holds no personal address by
         construction, and this simply carries that forward. */
      workEmail: str(person.workEmail),
    },
    organisation: {
      name: str(handover.company?.name),
      domain: str(handover.company?.domain),
    },

    source: {
      /* The stored value names the product; the payload names its ROLE. A
         handover that came from the marketing engine says so, and a client
         never learns which engine. */
      system: str(handover.marketing?.sourceSystem) ? "marketing_engine" : "",
      campaignName: str(handover.marketing?.campaignName),
      assetName: str(handover.marketing?.assetName),
      firstSeenAt: handover.marketing?.firstSeenAt || null,
      lastEngagedAt: handover.marketing?.lastEngagedAt || null,
    },

    assessment: {
      accountFit: handover.assessment?.accountFit || "unknown",
      intent: handover.assessment?.intent || "low",
      handoverReason: str(handover.assessment?.handoverReason),
      recommendedAction: str(handover.assessment?.recommendedAction),
      /* Freshness as recorded. `null` means it was never measured, which is a
         different statement from "the evidence is brand new". */
      evidenceFreshnessHours: handover.assessment?.evidenceFreshnessHours ?? null,
      rulesVersion: str(handover.assessment?.rulesVersion),
    },

    /* ── WHAT SALES SAID ──────────────────────────────────────────────────
       From Marketing's own record of a delivered announcement. Present only
       when there is a decision, so a caller cannot render an empty decision
       block as an undecided one. */
    decision: decided
      ? {
        decision: str(outcome.decision),
        decidedAt: outcome.decidedAt || null,
        decidedBy: str(outcome.decidedBy?.name),
        reason: str(outcome.reason),
        /* Only a return carries these, and only a return should show them. */
        nurtureTopic: str(outcome.decision) === "RETURNED" ? str(outcome.nurtureTopic) : "",
        revisitAt: str(outcome.decision) === "RETURNED" ? (outcome.revisitAt || null) : null,
      }
      : null,

    /* ── THE CANONICAL SALES RECORD: IDENTITY ONLY ────────────────────────
       Type, id and reference. No name, no status, no value. The frontend builds
       its own link; Marketing holds no copy that could go stale and no field it
       could be tempted to edit. */
    salesRecord: decided && (outcome.salesRecordId || str(outcome.salesRecordRef))
      ? {
        type: str(outcome.salesRecordType),
        id: outcome.salesRecordId ? String(outcome.salesRecordId) : null,
        ref: str(outcome.salesRecordRef),
      }
      : null,

    delivery,
    responseTiming: responseTimingOf(handover, delivery, measuredAt),
    acquisition: acquisitionOf(handover, hold),
  };
}

/* ═══ THE LIST ═════════════════════════════════════════════════════════════ */

function assertCompany(companyId) {
  if (!companyId) {
    throw fail("TENANT_MEMBERSHIP_UNPROVEN", "Marketing handovers cannot be read without a company.");
  }
  return companyId;
}

/** The requested filter, or a refusal naming what is accepted. */
function assertFilter(state) {
  const wanted = str(state) || "all";
  if (!LIST_FILTERS.includes(wanted)) {
    throw fail("VALIDATION", `"${wanted}" is not a handover state this list can filter by.`, {
      field: "state", accepted: LIST_FILTERS,
    });
  }
  return wanted;
}

/**
 * Decode a cursor, refusing anything that is not one.
 *
 * ── AND A CURSOR CARRIES NO AUTHORITY ─────────────────────────────────────
 * It is only ever a position within a selector that already carries the
 * company. A cursor minted against another company's page therefore reveals
 * nothing: it points at an `_id` that this company's selector does not match,
 * and the page comes back empty rather than borrowed.
 */
function decodeCursor(cursor) {
  const raw = str(cursor);
  if (!raw) return null;
  if (!/^[a-f0-9]{24}$/i.test(raw)) {
    throw fail("VALIDATION", "That is not a valid page cursor.", { field: "cursor" });
  }
  return raw;
}

/**
 * Exact counts by state for this company.
 *
 * Every state is present, including the ones at zero, so a client renders a
 * stable set of chips rather than inferring which are missing. The zeroes here
 * are MEASURED: the aggregate ran and found none. A failed read throws out of
 * this function and the whole request fails, because a count that silently
 * became zero is the worst possible answer — it looks like good news.
 */
async function summaryFor({ companyId } = {}) {
  /* Guarded here as well as in `list`, because this is exported and an
     aggregate without a `$match` on the company would count every company's
     handovers into one number. */
  assertCompany(companyId);
  const rows = await Handover.aggregate([
    { $match: { companyId } },
    { $group: { _id: "$state", n: { $sum: 1 } } },
  ]);

  const byState = Object.fromEntries(HANDOVER_STATE_CODES.map((s) => [s, 0]));
  let total = 0;
  for (const r of rows) {
    if (r._id in byState) byState[r._id] = r.n;
    total += r.n;
  }
  return { total, byState };
}

/**
 * One page of handovers, with everything the page needs about each.
 *
 * @returns {Promise<{rows:Array, summary:object, nextCursor:string|null,
 *                    hasMore:boolean, measuredAt:Date, filter:string}>}
 */
async function list({
  companyId, state = "all", cursor = null, limit = DEFAULT_PAGE, now = new Date(),
} = {}) {
  assertCompany(companyId);
  const filter = assertFilter(state);
  const after = decodeCursor(cursor);
  const pageSize = Math.max(1, Math.min(Number(limit) || DEFAULT_PAGE, MAX_PAGE));

  const selector = { companyId };
  if (filter !== "all") selector.state = filter;
  /* Newest first, keyed on `_id` alone. `createdAt` is not unique — two
     handovers submitted in the same millisecond would make a cursor ambiguous,
     and an ambiguous cursor skips or repeats rows at the page boundary. */
  if (after) selector._id = { $lt: after };

  /* One more than asked for, so `hasMore` is a fact rather than a guess from a
     full-looking page. */
  const found = await Handover.find(selector).sort({ _id: -1 }).limit(pageSize + 1).lean();
  const hasMore = found.length > pageSize;
  const page = hasMore ? found.slice(0, pageSize) : found;

  /* ── TWO BATCH READS, NOT TWO PER ROW ──────────────────────────────────
     Both company-scoped. A page of 25 costs two queries here rather than 50. */
  const refs = page.map((h) => str(h.handoverRef)).filter(Boolean);
  const correlationIds = page.map((h) => str(h.correlationId)).filter(Boolean);

  const [holds, outboxRows] = await Promise.all([
    acquisitionHold.statesFor({ companyId, handoverRefs: refs, now }),
    correlationIds.length
      ? MarketingOutboxEvent.find({
        companyId,
        kind: MARKETING_EVENT_KINDS.HANDOVER_SUBMITTED,
        correlationId: { $in: correlationIds },
      }).lean()
      : [],
  ]);
  const outboxByCorrelation = new Map(outboxRows.map((e) => [str(e.correlationId), e]));

  const summary = await summaryFor({ companyId });

  return {
    rows: page.map((h) => rowOf(h, {
      outboxEvent: outboxByCorrelation.get(str(h.correlationId)) || null,
      hold: holds.get(str(h.handoverRef)) || null,
      measuredAt: now,
    })),
    summary,
    /* Null when the page ended the list. A cursor that is not null is always a
       real position, never an empty string a client has to test for. */
    nextCursor: hasMore ? String(page[page.length - 1]._id) : null,
    hasMore,
    /* Every "awaiting" duration in this payload is relative to this moment, so
       it travels with the payload rather than being assumed to be "now". */
    measuredAt: now,
    filter,
  };
}

/* ═══ ONE HANDOVER ═════════════════════════════════════════════════════════ */

/**
 * Everything Marketing holds about one handover.
 *
 * The same delivery, timing and acquisition presentation the list uses, plus the
 * evidence and the audit trail — which is the whole reason the detail view
 * exists, and the part a list can never carry.
 */
async function detail({ companyId, handoverRef, now = new Date() } = {}) {
  assertCompany(companyId);
  const ref = str(handoverRef);
  if (!ref) {
    throw fail("VALIDATION", "A handover is addressed by its reference.", { field: "handoverRef" });
  }

  const handover = await Handover.findOne({ companyId, handoverRef: ref }).lean();
  if (!handover) throw fail("NOT_FOUND", "That handover was not found.");

  const [history, hold, outboxEvent] = await Promise.all([
    MarketingAuditEvent.find({ companyId, handoverRef: ref }).sort({ at: 1, _id: 1 }).lean(),
    acquisitionHold.stateFor({ companyId, handoverRef: ref, now }),
    MarketingOutboxEvent.findOne({
      companyId,
      kind: MARKETING_EVENT_KINDS.HANDOVER_SUBMITTED,
      correlationId: str(handover.correlationId),
    }).lean(),
  ]);

  return {
    row: rowOf(handover, { outboxEvent, hold: hold.exists ? hold : null, measuredAt: now }),

    /* ── THE EVIDENCE, WHICH ONLY THE DETAIL VIEW CARRIES ─────────────────
       Concise engagement lines, the provenance of anything enriched, and the
       ledger rows the handover was built from. Identity and description, never
       the raw provider response — that is somebody else's copy of a person's
       data and this is not its system of record. */
    evidence: {
      activities: (handover.activities || []).map((a) => ({
        kind: a.kind,
        occurredAt: a.occurredAt,
        campaignName: str(a.campaignName),
        assetName: str(a.assetName),
        detail: str(a.detail),
        sourceEventId: str(a.sourceEventId),
      })),
      topicsOfInterest: handover.topicsOfInterest || [],
      /* The buyer's own request, when the handover came from a lead source. */
      sourceEnquiry: handover.sourceEnquiry || null,
      sourceEventIds: handover.sourceEventIds || [],
      provenance: (handover.provenance || []).map((p) => ({
        provider: str(p.provider),
        retrievedAt: p.retrievedAt,
        fields: p.fields || [],
      })),
    },

    /* Consent as Marketing recorded it at submission, so a reader can see what
       the handover was allowed to be. Not the canonical record: that lives in
       MarketingConsent and is read through its own service. */
    permission: {
      emailConsent: handover.permission?.emailConsent || "unknown",
      phoneConsent: handover.permission?.phoneConsent || "unknown",
      capturedAt: handover.permission?.capturedAt || null,
      capturedSource: str(handover.permission?.capturedSource),
      suppressed: Boolean(handover.permission?.suppressed),
      acquisitionPausedAt: handover.permission?.acquisitionPausedAt || null,
    },

    assessmentFactors: {
      accountFitFactors: handover.assessment?.accountFitFactors || [],
      intentFactors: handover.assessment?.intentFactors || [],
    },

    history: history.map((h) => ({
      action: h.action,
      at: h.at,
      actor: str(h.actor?.name),
      reason: str(h.reason),
      previousState: str(h.previousState),
      resultingState: str(h.resultingState),
      details: h.details || null,
    })),

    blockedReason: str(handover.blockedReason),
    measuredAt: now,
  };
}

module.exports = {
  list,
  detail,
  summaryFor,
  rowOf,
  deliveryOf,
  responseTimingOf,
  acquisitionOf,
  assertFilter,
  decodeCursor,
  validDate,
  elapsedBetween,
  TIMING_BASIS,
  LIST_FILTERS,
  MAX_PAGE,
  DEFAULT_PAGE,
  DELIVERY,
};

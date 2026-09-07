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
const itemBudgetHead = require("./itemBudgetHead.service");
const mongoose = require("mongoose");

/** Service lines only. A product is received into stock and has no service. */
const isServiceRequest = (doc) =>
  doc?.requestType === "SERVICE" || doc?.requestType === "SOFTWARE";

/**
 * Every fact the classification screen and the finance gate both need.
 *
 * ── ONE READER, TWO CALLERS ─────────────────────────────────────────────────
 * The screen shows the relationship and finance is blocked on it. Computing
 * that twice is how a screen ends up saying "all lines agree" while the server
 * refuses the approval, so both read this.
 */
async function serviceClassification(doc) {
  const Service = require("../models/CMS_Models/Inventory/Services/Service");

  /* ── WHAT THIS DEPARTMENT MAY ACTUALLY SPEND AGAINST ──────────────────────
     Approved BUDGET LINES, from the same matcher the picker and the commitment
     use — not the set of mappable expense ledgers. A ledger being classifiable
     as spend says nothing about whether this department has money on it, and
     calling the first thing "available budget" is precisely the misreading
     this chunk has to avoid. */
  let heads = [];
  if (doc.companyId) {
    const got = await budgetMatch.approvedHeadsFor({
      companyId: doc.companyId,
      department: doc.department || "",
    }).catch(() => ({ heads: [] }));
    heads = got.heads || [];
  }
  const availableHeadIds = heads.map((h) => String(h.ledgerId));

  const ids = [...new Set((doc.items || [])
    .map((l) => (l.service ? String(l.service) : null))
    .filter((id) => id && mongoose.isValidObjectId(id)))];

  const services = ids.length
    ? new Map((await Service.find({ _id: { $in: ids }, companyId: doc.companyId })
      .select("_id serviceCode name category billingUnit sacCode status "
        + "budgetLedgerId budgetLedgerName defaultGstRate defaultRate preferredVendorName")
      .lean()).map((sv) => [String(sv._id), sv]))
    : new Map();

  const requestLedgerId = doc.ledgerId ? String(doc.ledgerId) : null;
  const requestLedgerName = doc.ledgerName || "";

  const lines = (doc.items || []).map((l) => {
    const sid = l.service ? String(l.service) : null;
    const svc = sid ? services.get(sid) : null;
    /* From the Service Master and nothing else — `headForService` takes no
       category map, so an Item Category mapping cannot reach a service line. */
    const resolution = svc ? itemBudgetHead.headForService(svc) : null;
    const agreement = resolution
      ? itemBudgetHead.serviceHeadAgreement({ resolution, requestLedgerId, availableHeadIds })
      : null;

    /* The master's own figures, carried ONLY as a comparison. The approved
       quote is what the line says and what any order will use. */
    const quotedGst = typeof l.gstPercent === "number" ? l.gstPercent : null;
    const differences = [];
    if (svc) {
      if (svc.defaultGstRate != null && quotedGst != null && Number(svc.defaultGstRate) !== quotedGst) {
        differences.push({ field: "gst", masterDefault: svc.defaultGstRate, quoted: quotedGst });
      }
      if (svc.defaultRate != null && Number(svc.defaultRate) !== Number(l.rate || 0)) {
        differences.push({ field: "rate", masterDefault: svc.defaultRate, quoted: Number(l.rate || 0) });
      }
      if (svc.preferredVendorName && l.vendorName
        && svc.preferredVendorName.trim().toLowerCase() !== String(l.vendorName).trim().toLowerCase()) {
        differences.push({ field: "vendor", masterDefault: svc.preferredVendorName, quoted: l.vendorName });
      }
    }

    return {
      spendLineId: String(l._id),
      name: l.name,
      /* The identity snapshot as STORED on the line, not re-read from the
         master — a rename after approval must not restate the request. */
      service: sid,
      serviceCode: l.serviceCode || null,
      billingUnit: l.billingUnit || null,
      sacCode: l.sacCode || null,
      matched: !!sid,
      /* ── WHY A LINE HAS NO USABLE SERVICE ──────────────────────────────
         Four distinct faults, and finance has to be able to tell them apart:
         nobody matched it, the match points at a record that is gone or
         belongs to another company (the query is company-scoped, so both
         answer as missing), or the service has since been retired. Reporting
         one word for all four leaves somebody guessing which desk to go to. */
      serviceMissing: !!sid && !svc,
      serviceInactive: !!svc && svc.status !== "ACTIVE",
      serviceStatus: svc?.status || null,
      /* `null` when the line is fine. Named so a screen and the refusal
         below cannot describe the same line differently. */
      identityFault: !sid
        ? "NOT_MATCHED"
        : !svc
          ? "SERVICE_NOT_IN_COMPANY"
          : svc.status !== "ACTIVE"
            ? "SERVICE_INACTIVE"
            : null,

      quoted: {
        vendorName: l.vendorName || null,
        rate: typeof l.rate === "number" ? l.rate : null,
        gstPercent: quotedGst,
        quantity: typeof l.quantity === "number" ? l.quantity : null,
        unit: l.unit || null,
        lineTotal: typeof l.lineTotal === "number" ? l.lineTotal : null,
      },
      /* Never applied. Shown so a buyer can see the master and the quote
         disagree and decide whether that matters. */
      masterDifferences: differences,

      serviceDefault: resolution
        ? {
          budgetLedgerId: resolution.budgetLedgerId ? String(resolution.budgetLedgerId) : null,
          budgetLedgerName: resolution.budgetLedgerName || null,
          source: resolution.source,
          message: resolution.message,
        }
        : null,
      agreement: agreement ? agreement.state : null,
      agreementMessage: agreement ? agreement.message : null,
      /* True only when the default is an APPROVED head for this department
         AND differs from the one the request is on. */
      adoptable: !!agreement && agreement.adoptable,

      allocation: l.budgetAllocation
        ? {
          budgetLedgerId: l.budgetAllocation.budgetLedgerId ? String(l.budgetAllocation.budgetLedgerId) : null,
          budgetLedgerName: l.budgetAllocation.budgetLedgerName || null,
          resolutionSource: l.budgetAllocation.resolutionSource || null,
          resolutionReason: l.budgetAllocation.resolutionReason || null,
          selectedByName: l.budgetAllocation.selectedByName || null,
          selectedAt: l.budgetAllocation.selectedAt || null,
          status: l.budgetAllocation.status || null,
        }
        /* Absent, not defaulted. A line nobody has classified has NO
           allocation, and rendering an "unresolved" object here would
           manufacture a decision on every legacy request. */
        : null,
    };
  });

  return {
    /* Absent on a request raised before classification was required. Carried
       so a screen can say "this predates the rule" rather than showing an
       unclassified request as broken. */
    policy: doc.serviceClassificationPolicy || null,
    requestHead: requestLedgerId
      ? { budgetLedgerId: requestLedgerId, budgetLedgerName: requestLedgerName }
      : null,
    department: doc.department || null,
    availableHeads: heads.map((h) => ({
      ledgerId: String(h.ledgerId),
      name: h.name,
      budgetLineId: h.budgetLineId,
      available: h.available,
    })),
    lines,
    unmatched: lines.filter((l) => !l.matched).length,
    identityFaults: lines.filter((l) => l.identityFault).length,
    mismatched: lines.filter(
      (l) => l.agreement === itemBudgetHead.AGREEMENT.DIFFERENT
        || l.agreement === itemBudgetHead.AGREEMENT.NOT_AVAILABLE,
    ).length,
  };
}


/* ══ FINANCE MUST CONSCIOUSLY RESOLVE A MISMATCH ═════════════════════════════
 *
 * ── WHY THIS BLOCKS RATHER THAN WARNS ───────────────────────────────────────
 * A warning on an approval screen is read once and then never again. The whole
 * point of moving service matching before finance is that somebody looks at
 * "this service normally comes out of Repairs, and you are approving it
 * against Software Subscriptions" WHILE the money can still be redirected.
 * A banner nobody has to answer would restore the old behaviour with extra
 * steps.
 *
 * So: an approval that would silently contradict a CONFIGURED default is
 * refused, with the mismatch in the payload, until finance says which head
 * they mean and why.
 *
 * ── AND WHAT IT DOES NOT BLOCK ──────────────────────────────────────────────
 * A service with no default blocks nothing: nobody has expressed an intention
 * to contradict, and demanding a reason for departing from a decision that was
 * never made is a form that teaches people to type "n/a".
 *
 * Nor does an unmatched line block approval. Matching is Store's job and this
 * is finance's decision; refusing here would strand a priced, confirmed
 * request behind somebody else's queue. It is reported, not enforced.
 */
function serviceApprovalGate({ request, body, actor }) {
  return serviceClassification(request).then((classification) => {
    /* ── IDENTITY FIRST, AND A REASON CANNOT BUY PAST IT ──────────────────
       A request raised under the classification policy must have every
       service line matched to a live, active, same-company service BEFORE
       finance approves. This used to be reported and not enforced, on the
       reasoning that matching is Store's job and blocking would strand a
       priced request behind somebody else's queue. That was wrong: an
       approval is the moment the money is promised, and promising it against
       lines nobody has identified is exactly the thing this chunk exists to
       stop. The queue argument is real, but it is an argument for Store
       classifying promptly, not for finance committing blind.

       This runs BEFORE the mismatch check and does not consult `reason`. A
       reason explains WHICH head was chosen; it cannot explain away a line
       whose service is unknown, deleted, another company's or retired —
       there is nothing there to have an opinion about.

       A request with no policy marker predates the rule and is exempt: it
       could not have been followed, and refusing it now would strand
       already-committed work. */
    if (request.serviceClassificationPolicy) {
      const faulted = classification.lines.filter((l) => l.identityFault);
      if (faulted.length) {
        return {
          ok: false,
          status: 409,
          code: "SERVICE_LINES_UNCLASSIFIED",
          message:
            `${faulted.length} service line${faulted.length === 1 ? "" : "s"} `
            + "on this request are not matched to a live service. Store must classify "
            + "them before it can be approved — a reason cannot stand in for a missing service.",
          classification,
          unclassified: faulted.map((l) => ({
            spendLineId: l.spendLineId,
            name: l.name,
            fault: l.identityFault,
            serviceCode: l.serviceCode,
            message: FAULT_MESSAGE[l.identityFault] || "This line has no usable service.",
          })),
        };
      }
    }

    const posted = new Map();
    for (const d of Array.isArray(body?.lines) ? body.lines : []) {
      if (d && d.spendLineId) posted.set(String(d.spendLineId), d);
    }
    const blanketReason = String(body?.reason || "").trim();

    const unanswered = [];
    for (const line of classification.lines) {
      /* Nothing configured to contradict. */
      if (!line.serviceDefault?.budgetLedgerId) continue;
      if (line.agreement === itemBudgetHead.AGREEMENT.MATCHES) continue;

      const answer = posted.get(line.spendLineId);
      const reason = String(answer?.reason || blanketReason || "").trim();
      if (!reason) {
        unanswered.push({
          spendLineId: line.spendLineId,
          name: line.name,
          serviceCode: line.serviceCode,
          agreement: line.agreement,
          serviceDefaultName: line.serviceDefault.budgetLedgerName,
          requestHeadName: classification.requestHead?.budgetLedgerName || null,
          message: line.agreementMessage,
        });
      }
    }

    if (unanswered.length) {
      return {
        ok: false,
        status: 409,
        code: "SERVICE_CLASSIFICATION_UNRESOLVED",
        message:
          `${unanswered.length} service line${unanswered.length === 1 ? "" : "s"} `
          + "do not use the budget head this service normally comes out of. "
          + "Say which head you mean and why before approving.",
        /* The whole picture, so the screen can render the choice rather than
           make finance go and find it. */
        classification,
        unresolved: unanswered,
      };
    }

    return { ok: true, classification };
  });
}

/** One sentence per fault, so a screen never has to invent its own. */
const FAULT_MESSAGE = Object.freeze({
  NOT_MATCHED: "No service has been matched to this line.",
  /* Deliberately one message for "gone" and "another company's". The lookup
     is company-scoped, so distinguishing them would confirm that a record
     exists somewhere else. */
  SERVICE_NOT_IN_COMPANY: "The matched service is not available in this company.",
  SERVICE_INACTIVE: "The matched service has been retired and cannot be used for new work.",
});

/**
 * Record what each service line was approved as.
 *
 * ── ONE HEAD, HONESTLY LABELLED ─────────────────────────────────────────────
 * The head stored on every line is the REQUEST-LEVEL head, because that is the
 * one the single commitment is written against and a line claiming a different
 * one would be a second authority. What varies is the SOURCE: `service_default`
 * where that head is the service's own configured default, `manual_selection`
 * where a person put it there over or in the absence of one.
 *
 * A line with no head in force at all is left honestly unresolved rather than
 * recorded as a manual selection of nothing.
 */
function applyServiceAllocations({ request, classification, actor, body }) {
  const posted = new Map();
  for (const d of Array.isArray(body?.lines) ? body.lines : []) {
    if (d && d.spendLineId) posted.set(String(d.spendLineId), d);
  }
  const blanketReason = String(body?.reason || "").trim();
  const byId = new Map(classification.lines.map((l) => [l.spendLineId, l]));

  for (const line of request.items || []) {
    const view = byId.get(String(line._id));
    /* Only lines actually matched to a service are classified here. An
       unmatched line keeps whatever it had — which for a legacy request is
       nothing at all, and manufacturing an allocation for it would invent a
       decision nobody made. */
    if (!view || !view.matched) continue;

    const answer = posted.get(String(line._id));
    const resolution = {
      budgetLedgerId: view.serviceDefault?.budgetLedgerId || null,
      budgetLedgerName: view.serviceDefault?.budgetLedgerName || "",
      category: null,
    };

    line.budgetAllocation = itemBudgetHead.serviceLineAllocation({
      resolution,
      /* The request's head. Not the service's — the service only recommends. */
      chosenLedgerId: request.ledgerId || null,
      chosenLedgerName: request.ledgerName || "",
      actor,
      reason: String(answer?.reason || blanketReason || "").trim(),
    });
  }
}

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
async function decide({
  request, actor, outcome, note = "", expectedPaymentDate = null,
  /* Finance's deliberate answer to a service-classification mismatch:
     `{ lines: [{ spendLineId, budgetLedgerId, reason }], reason }`. Absent on
     an ordinary approval, and absent is the common case — a request whose
     every line already agrees needs no answer. */
  lineDecisions = null,
} = {}) {
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

  /* ── AND A SERVICE'S CLASSIFICATION HAS TO HAVE BEEN LOOKED AT ─────────
     Only for SERVICE requests, only on approval, and only where there is
     something to answer. Rejection stays ungated throughout: refusing an
     unclassified request is a perfectly good answer. */
  let classification = null;
  if (outcome !== "rejected" && isServiceRequest(request)) {
    const gate = await serviceApprovalGate({ request, body: lineDecisions, actor });
    if (!gate.ok) return gate;
    classification = gate.classification;
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

    /* ── WHAT EACH SERVICE LINE IS ON THE RECORD AS ────────────────────
       Written from the classification the gate above has already validated,
       so the stored allocation and the thing finance was shown are the same
       object. The HEAD is the request-level one either way — B2 keeps one
       commitment — and the SOURCE says whether that head is the service's own
       default or a person's decision over it. */
    if (classification) applyServiceAllocations({ request, classification, actor, body: lineDecisions });

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

module.exports = {
  decide, AT_FINANCE, serviceClassification, isServiceRequest,
  serviceApprovalGate, applyServiceAllocations,
};

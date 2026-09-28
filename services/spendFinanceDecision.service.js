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
const lineAllocation = require("./lineAllocation.service");
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

/* ══ LINE-WISE BUDGET ALLOCATION ═════════════════════════════════════════════
 *
 * ── THE PROBLEM ─────────────────────────────────────────────────────────────
 * One request buys fabric, packaging, freight and a repair. Those come out of
 * four different budgets, and the only thing a commitment could express was
 * ONE head — so finance either split the request into four or charged three of
 * them somewhere they do not belong. The budget report was then wrong about
 * all four, in a way nobody could see from the report.
 *
 * ── WHAT THIS DECIDES, AND WHAT IT DOES NOT ─────────────────────────────────
 * It resolves a head PER LINE, validates each against this department's
 * approved budget lines, splits the approved grand total across the lines to
 * the paise, groups lines sharing a head, and checks each GROUP once.
 *
 * It does NOT decide whether finance may approve past a head. That is the
 * existing policy — finance can always say yes, and the request records which
 * KIND of yes it was — and applying it at the grouped level is the whole
 * point. A second framework that blocked an over-budget group would be a
 * different rule for line-wise requests than for every other one.
 */

/** Finance's per-line instruction, keyed by line id. */
function selectionMap(body) {
  const out = new Map();
  for (const l of Array.isArray(body?.lines) ? body.lines : []) {
    if (l && l.spendLineId) out.set(String(l.spendLineId), l);
  }
  return out;
}

/**
 * Resolve, validate, split and group.
 *
 * `body` is finance's answer:
 *   { lines: [{ spendLineId, budgetLineId, reason, unbudgeted }], reason }
 */
async function planLineAllocations({ request, body = null, actor = null } = {}) {
  const RawItem = require("../models/CMS_Models/Inventory/Products/RawItem");
  const Service = require("../models/CMS_Models/Inventory/Services/Service");

  /* ── WHAT THIS DEPARTMENT MAY ACTUALLY SPEND AGAINST ──────────────────────
     Approved BUDGET LINES, from the same matcher the request header already
     uses. A ledger being classifiable as spend says nothing about whether this
     department has money on it, and accepting one because it exists in the
     chart of accounts is exactly what must not happen. */
  const { heads: approvedHeads } = await budgetMatch.approvedHeadsFor({
    companyId: request.companyId,
    department: request.budgetDepartment || request.department || "",
  }).catch(() => ({ heads: [] }));

  const byLedger = new Map(approvedHeads.map((h) => [String(h.ledgerId), h]));
  const byLine = new Map(approvedHeads.map((h) => [String(h.budgetLineId), h]));

  /* ── THE SPLIT ────────────────────────────────────────────────────────────
     Refused outright rather than approximated: a commitment whose parts do not
     equal the approved total is a figure nobody can reconcile. */
  const split = lineAllocation.allocateLines({
    lines: request.items || [],
    grandTotal: typeof request.grandTotal === "number" && request.grandTotal > 0
      ? request.grandTotal
      : request.totalAmount,
  });
  if (!split.ok) {
    return { ok: false, status: 400, code: split.code, message: split.message };
  }

  const serviceRequest = isServiceRequest(request);

  /* One category map for the whole request, and only for a PRODUCT request.
     A service never consults it — `headForService` takes no map at all. */
  const categoryMap = serviceRequest
    ? new Map()
    : await itemBudgetHead.categoryMap(request.companyId);

  const itemIds = (request.items || []).map((l) => l.rawItem).filter(Boolean);
  const items = itemIds.length
    ? new Map((await RawItem.find({ _id: { $in: itemIds } })
      .select("_id name sku category budgetLedgerId budgetLedgerName").lean())
      .map((i) => [String(i._id), i]))
    : new Map();

  const serviceIds = (request.items || []).map((l) => l.service).filter(Boolean);
  const services = serviceIds.length
    ? new Map((await Service.find({ _id: { $in: serviceIds }, companyId: request.companyId })
      .select("_id serviceCode name category budgetLedgerId budgetLedgerName status").lean())
      .map((s) => [String(s._id), s]))
    : new Map();

  const selections = selectionMap(body);
  const blanketReason = String(body?.reason || "").trim();

  /* The head the request itself was approved against, when it has one. */
  const requestHead = request.budgetMatchStatus === "matched" && request.budgetLineId
    ? byLine.get(String(request.budgetLineId)) || null
    : null;
  /* And whether it deliberately has none — the existing exception path. */
  const requestUnbudgeted = request.budgetMatchStatus !== "matched";

  const rows = [];
  const problems = [];

  for (const [index, line] of (request.items || []).entries()) {
    const lineId = String(line._id);
    const amounts = split.allocations[index];
    const choice = selections.get(lineId) || null;

    /* ── THE SUGGESTION ───────────────────────────────────────────────────
       Product: its own override, then its category's mapping, then nothing.
       Service: the Service Master default and nothing else — no category
       fallback, enforced by `headForService` taking no map. */
    const svc = line.service ? services.get(String(line.service)) : null;
    const item = line.rawItem ? items.get(String(line.rawItem)) : null;
    const suggestion = serviceRequest
      ? itemBudgetHead.headForService(svc || {})
      : itemBudgetHead.headForItem(item || { category: line.category }, categoryMap);

    const suggestedLedgerId = suggestion.budgetLedgerId ? String(suggestion.budgetLedgerId) : null;
    const suggestedHead = suggestedLedgerId ? byLedger.get(suggestedLedgerId) : null;

    /* ── WHAT FINANCE CHOSE, IF ANYTHING ──────────────────────────────────
       An explicit `unbudgeted: true` is a real decision and is honoured; a
       named `budgetLineId` must be one of this department's approved lines. */
    let head = null;
    let source = suggestion.source;
    let reason = "";
    let unbudgeted = false;

    if (choice && choice.unbudgeted === true) {
      unbudgeted = true;
      source = itemBudgetHead.SOURCE_MANUAL;
      reason = String(choice.reason || blanketReason || "").trim();
    } else if (choice && choice.budgetLineId) {
      const picked = byLine.get(String(choice.budgetLineId));
      if (!picked) {
        /* Not this department's, not approved, or not live. One message for
           all three: naming which would tell a caller that a budget line they
           cannot use exists somewhere. */
        problems.push({
          spendLineId: lineId, name: line.name, code: "HEAD_NOT_APPROVED",
          message: "That budget head is not an approved line for this department.",
        });
        continue;
      }
      head = picked;
      /* Manual only where it DIFFERS from what the rule suggested. Choosing
         the suggestion by hand is still the suggestion. */
      const same = suggestedHead && String(suggestedHead.budgetLineId) === String(picked.budgetLineId);
      source = same ? suggestion.source : itemBudgetHead.SOURCE_MANUAL;
      reason = String(choice.reason || blanketReason || "").trim();

      /* ── OVERRIDING A CONFIGURED DEFAULT OWES A REASON ─────────────────
         Only where there WAS a default to contradict. A line whose rule
         produced nothing has nothing to have departed from, and demanding a
         reason for that teaches people to type "n/a". */
      if (!same && suggestedLedgerId && !reason) {
        problems.push({
          spendLineId: lineId, name: line.name, code: "REASON_REQUIRED",
          suggestedLedgerName: suggestion.budgetLedgerName || null,
          selectedLedgerName: picked.name,
          message: `${line.name} normally comes out of ${suggestion.budgetLedgerName || "another head"}. `
            + "Say why it is being charged elsewhere.",
        });
        continue;
      }
    } else if (suggestedHead) {
      head = suggestedHead;
    } else if (!suggestedLedgerId && requestHead) {
      /* ── THE REQUEST'S OWN HEAD, WHERE NOTHING ELSE SPEAKS ────────────
         Before line-wise allocation this WAS the only authority, and it is
         still a real decision: the requester picked it from their own
         department's approved lines and finance is approving the request on
         it. A line whose own rule produces nothing falls back to it rather
         than being refused — refusing would make every request that predates
         item-wise mapping unapprovable.

         Recorded as `request_head`, never as a line-level source, so nobody
         can later mistake "nothing else said otherwise" for "somebody
         classified this line". */
      head = requestHead;
      source = itemBudgetHead.SOURCE_REQUEST_HEAD;
    } else if (!suggestedLedgerId && requestUnbudgeted) {
      /* The request itself has no approved head — the explicit unbudgeted
         path. Its lines are unbudgeted too: still promises, reducing nothing,
         and visible as such. */
      unbudgeted = true;
      source = itemBudgetHead.SOURCE_NONE;
    } else if (suggestedLedgerId) {
      /* The rule produced a head this department has no approved budget on.
         Not silently unbudgeted, and not silently charged: finance must say
         which head they mean. */
      problems.push({
        spendLineId: lineId, name: line.name, code: "SUGGESTED_HEAD_UNAVAILABLE",
        suggestedLedgerName: suggestion.budgetLedgerName || null,
        message: `${suggestion.budgetLedgerName || "The suggested head"} is not an approved `
          + "budget head for this department. Choose one, or mark the line unbudgeted.",
      });
      continue;
    } else {
      /* ── UNRESOLVED IS NOT AN APPROVAL ────────────────────────────────
         Nothing resolved it and finance chose nothing. Refused rather than
         quietly recorded against the request header's head, which is how a
         line ends up charged somewhere nobody picked. */
      problems.push({
        spendLineId: lineId, name: line.name, code: "LINE_UNRESOLVED",
        message: `${line.name} has no budget head. Choose one, or mark it unbudgeted.`,
      });
      continue;
    }

    rows.push({
      spendLineId: lineId,
      name: line.name || "",
      itemId: item?._id || line.rawItem || undefined,
      itemSku: item?.sku || line.rawItemSku || "",
      serviceId: svc?._id || line.service || undefined,
      serviceCode: svc?.serviceCode || line.serviceCode || "",

      budgetId: unbudgeted ? null : head.budgetId,
      budgetLineId: unbudgeted ? null : head.budgetLineId,
      financialYear: unbudgeted ? null : head.financialYear,
      ledgerId: unbudgeted ? null : head.ledgerId,
      ledgerName: unbudgeted ? "" : head.name,

      amount: amounts.amount,
      adjustment: amounts.adjustment,
      lineAmount: amounts.lineAmount,
      status: unbudgeted ? "unbudgeted" : "committed",

      resolutionSource: unbudgeted ? itemBudgetHead.SOURCE_MANUAL : source,
      resolutionReason: reason,
      selectedByName: (choice ? (actor?.name || "") : ""),
      selectedAt: choice ? new Date() : undefined,

      /* What the SUGGESTION was, carried for the screen. Not stored on the
         commitment — the commitment records what was decided, not what was
         proposed. */
      suggested: {
        budgetLedgerId: suggestedLedgerId,
        budgetLedgerName: suggestion.budgetLedgerName || null,
        source: suggestion.source,
        available: !!suggestedHead,
      },
    });
  }

  if (problems.length) {
    return {
      ok: false,
      status: 409,
      code: "LINE_ALLOCATION_UNRESOLVED",
      message: `${problems.length} line${problems.length === 1 ? "" : "s"} need a budget head `
        + "before this can be approved.",
      problems,
      totals: split.totals,
    };
  }

  /* ── GROUPED, THEN CHECKED ONCE ───────────────────────────────────────────
     Two lines on one head are ONE claim on its headroom. Checking them
     separately lets each read the same starting availability and each conclude
     it fits — so ₹6,000 and ₹5,000 both pass against ₹10,000 and the head goes
     ₹1,000 over on two individually correct approvals. */
  const grouped = lineAllocation.groupByBudgetLine(rows);
  const availability = new Map(approvedHeads.map((h) => [String(h.budgetLineId), {
    approved: h.approved, committed: h.committed, actual: h.actual, available: h.available,
  }]));
  const checked = lineAllocation.checkGroups({ groups: grouped.heads, availability });

  /* Each allocation carries the state of ITS head at the moment of the
     promise. A single top-level snapshot could only describe one of them. */
  const byLineId = new Map(checked.map((g) => [String(g.budgetLineId), g]));
  for (const r of rows) {
    if (!r.budgetLineId) continue;
    const g = byLineId.get(String(r.budgetLineId));
    if (!g || !g.known) continue;
    r.snapshot = {
      approved: g.approved,
      committedBefore: g.committedBefore,
      actual: g.actual,
      availableBefore: g.availableBefore,
      availableAfter: g.availableAfter,
    };
  }

  return {
    ok: true,
    allocations: rows,
    groups: checked,
    unbudgeted: grouped.unbudgeted,
    totals: split.totals,
    /* The existing vocabulary, applied at the grouped level. Finance is not
       blocked by any of these — the request records which kind of yes it was. */
    approvalKind: !rows.some((r) => r.status === "committed")
      ? "unbudgeted"
      : checked.some((g) => g.status === "insufficient" || !g.known)
        ? "over_budget"
        : "within_budget",
    headCount: checked.length,
  };
}

/** The plan, shaped for a screen: per line, per head, and the totals. */
function allocationSummary(plan) {
  if (!plan || !plan.ok) return null;
  return {
    mode: plan.headCount > 1 || (plan.allocations || []).length > 1 ? "line_wise" : "single_head",
    headCount: plan.headCount,
    approvalKind: plan.approvalKind,
    lines: (plan.allocations || []).map((a) => ({
      spendLineId: a.spendLineId,
      name: a.name,
      itemSku: a.itemSku || null,
      serviceCode: a.serviceCode || null,
      /* The line's own figure, the header adjustment it absorbed, and the
         committed amount — all three, so "why is this less than quoted" has
         an answer on the screen rather than in somebody's head. */
      lineAmount: a.lineAmount,
      adjustment: a.adjustment,
      amount: a.amount,
      budgetLineId: a.budgetLineId ? String(a.budgetLineId) : null,
      ledgerId: a.ledgerId ? String(a.ledgerId) : null,
      ledgerName: a.ledgerName || null,
      status: a.status,
      resolutionSource: a.resolutionSource,
      resolutionReason: a.resolutionReason || "",
      selectedByName: a.selectedByName || "",
      suggested: a.suggested || null,
      snapshot: a.snapshot || null,
    })),
    /* Grouped, because two lines on one head are ONE claim on its headroom. */
    heads: (plan.groups || []).map((g) => ({
      budgetLineId: g.budgetLineId,
      ledgerId: g.ledgerId ? String(g.ledgerId) : null,
      ledgerName: g.ledgerName,
      financialYear: g.financialYear || null,
      lineCount: g.lineCount,
      amount: g.amount,
      known: g.known,
      approved: g.approved ?? null,
      committedBefore: g.committedBefore ?? null,
      actual: g.actual ?? null,
      availableBefore: g.availableBefore ?? null,
      availableAfter: g.availableAfter ?? null,
      shortfall: g.shortfall ?? 0,
      status: g.status,
    })),
    unbudgeted: plan.unbudgeted,
    totals: plan.totals,
  };
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
  /* Finance's per-line budget heads:
     `{ lines: [{ spendLineId, budgetLineId, reason, unbudgeted }], reason }`.
     Absent when every line resolves on its own, which is the common case. */
  lineAllocations = null,
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

  /* ── AND EVERY LINE NEEDS A BUDGET HEAD ────────────────────────────────
     Resolved per line, validated against this department's approved lines,
     split to the paise and checked in GROUPS. An unresolved line is refused
     rather than quietly charged to the request header's head — which is how a
     line ends up on a budget nobody chose. Over-budget is NOT refused here:
     that is the existing policy's call, and it is recorded below. */
  let plan = null;
  if (outcome !== "rejected") {
    plan = await planLineAllocations({ request, body: lineAllocations, actor });
    if (!plan.ok) return plan;
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
    /* ── THE SAME THREE WORDS, NOW ASKED OF THE GROUPS ──────────────────
       `within_budget` / `over_budget` / `unbudgeted` are unchanged, and so is
       the rule that finance can always say yes. What changed is what they
       describe: with several heads on one request, the request-header snapshot
       could only ever have described one of them. The plan answers for every
       head, and a request is over budget if ANY group is. */
    const snap = request.budgetSnapshot;
    request.budgetApprovalKind = plan
      ? plan.approvalKind
      : (request.budgetMatchStatus !== "matched"
        ? "unbudgeted"
        : snap && Number(snap.availableAfter) < 0
          ? "over_budget"
          : "within_budget");

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
          /* One document, one row per approved line. Already validated above;
             `commit` decides the document's SHAPE, not the allocation. */
          allocations: plan ? plan.allocations : null,
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

  /* The plan travels back so the decision response can show what was
     committed, per line and per head, without recomputing it. */
  return { ok: true, plan };
}

module.exports = {
  decide, AT_FINANCE, serviceClassification, isServiceRequest,
  planLineAllocations,
  allocationSummary,
  serviceApprovalGate, applyServiceAllocations,
};

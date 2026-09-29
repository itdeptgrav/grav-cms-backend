// services/sales/lineProcessRequirement.js
//
// WHAT THIS LINE'S BUYER APPROVED: EMBROIDERY, PRINTING, WASHING.
//
// ── WHY SALES STATES IT, PER LINE ───────────────────────────────────────────
// IE engineers a route per style. Two confirmed lines of one style can differ
// — one buyer wants a chest logo, another a plain garment, a third an enzyme
// wash — so the style cannot say what THIS line needs. The buyer's requirement
// is a commercial fact, and commercial facts are Sales'. Sales states it on
// the handover it issues for the exact permanent `lineRef`, the version
// freezes it, and Merchandising and PPC read it from there.
//
// ── WHAT A STATEMENT MUST BE ────────────────────────────────────────────────
//   · EMBROIDERY, PRINTING and WASHING each appear exactly once;
//   · each is REQUIRED, NOT_REQUIRED or UNKNOWN — said, never defaulted;
//   · a definite answer (REQUIRED / NOT_REQUIRED) names the buyer approval it
//     rests on and says, in the buyer's terms, what was approved;
//   · OTHER processes may be added, each with a label saying what it is.
// An enquiry checkbox, a style flag, a free-text note or a missing answer is
// never read as NOT_REQUIRED — nothing here reads any of them.
//
// ── AND WHICH LINE IT SPEAKS FOR ────────────────────────────────────────────
// A buyer approval is evidence for a line only when the approved quotation
// round names that exact line — by its permanent reference, or by a commercial
// product-line reference that is one-to-one on both sides. A shared style is
// never enough: two lines of one style are the case this contract exists for.
//
// ── WHAT COUNTS AS BUYER APPROVAL ───────────────────────────────────────────
// A record the buyer produced, already stored on THIS order: a quotation the
// customer approved with the purchase order they sent uploaded as its proof
// (`quotations[].customerApproval` + `poProof`). The caller names it; the
// server finds it on the order and freezes its identity — never its price.
// An order confirmed through an internal override has no such record, so it
// can only say UNKNOWN, and PPC stays blocked until the buyer's approval is
// on file.
"use strict";

const { fail } = require("../storePurchase/errors");

const str = (v) => String(v ?? "").trim();

const CORE_PROCESSES = Object.freeze(["EMBROIDERY", "PRINTING", "WASHING"]);
const PROCESSES = Object.freeze([...CORE_PROCESSES, "OTHER"]);
const REQUIREMENTS = Object.freeze(["REQUIRED", "NOT_REQUIRED", "UNKNOWN"]);
const DEFINITE = Object.freeze(["REQUIRED", "NOT_REQUIRED"]);
const LIMITS = Object.freeze({ SPECIFICATION: 500, OTHER_LABEL: 80, OTHERS: 5 });

/** The only fields a statement and each of its rows may carry. */
const STATEMENT_FIELDS = Object.freeze(["processes"]);
const ROW_FIELDS = Object.freeze([
  "process", "otherLabel", "requirement", "buyerSpecification", "evidenceRef", "authorisationReason",
]);
const REASON_MIN = 10;

const documentRef = (proof) => str(proof?.publicId) || str(proof?.fileId) || str(proof?.url);
const time = (d) => (d ? new Date(d).getTime() : NaN);

/**
 * Does this approved round cover THIS order line — provably?
 *
 * Only two things prove it: the line's own permanent reference on a round
 * item, or a commercial product-line reference that names one round item and
 * one order line and nothing else. Anything weaker is not proof:
 *
 *   · a shared STYLE is not proof — two lines of one style are exactly the
 *     case this contract exists for, and a style-matched PO would approve the
 *     wrong line's embroidery;
 *   · a product-line reference carried by two round items, or by two lines of
 *     this order, is not one-to-one and names neither of them;
 *   · a round whose items identify no line at all — a manually typed
 *     quotation — proves nothing for any line, rather than everything for all
 *     of them.
 * An unproven round is simply not offered, and the line reads "not stated".
 */
function roundCoversLine(round, item, request = null) {
  if (!item) return false;
  const rows = round?.items || [];
  const wantedLine = str(item.lineRef);
  if (wantedLine && rows.some((i) => str(i?.lineRef) === wantedLine)) return true;

  const wantedProductLine = str(item.productLineRef);
  if (!wantedProductLine) return false;
  const onRound = rows.filter((i) => str(i?.productLineRef) === wantedProductLine);
  const onOrder = (request?.items || []).filter((i) => str(i?.productLineRef) === wantedProductLine);
  return onRound.length === 1 && onOrder.length === 1;
}

/**
 * The buyer approvals a definite answer for this line may rest on.
 *
 * Only a quotation round the CUSTOMER approved, with a purchase order that
 * belongs to THAT round:
 *   · uploaded on or after the round was issued — a revision resets the
 *     round's date and keeps an older round's PO on it, and that PO approved
 *     the older round, not this one;
 *   · not a document an archived round already carried;
 * and a round that covers this line. Sales pushing an order through without
 * the customer's approval leaves no such PO, so it offers nothing. The
 * reference pins the round's revision, so a reference read before a revise
 * does not resolve to the round after it. No price, PO value or quotation
 * content leaves this function.
 */
function buyerApprovals(request, item = null) {
  const archivedDocs = new Set((request?.quotationRevisions || []).map((q) => documentRef(q?.poProof)).filter(Boolean));
  return (request?.quotations || [])
    .filter((q) => q?.customerApproval?.approved === true && documentRef(q.poProof))
    .filter((q) => !archivedDocs.has(documentRef(q.poProof)))
    .filter((q) => Number.isFinite(time(q.poProof.uploadedAt))
      && (!Number.isFinite(time(q.date)) || time(q.poProof.uploadedAt) >= time(q.date)))
    .filter((q) => roundCoversLine(q, item, request))
    .map((q) => ({
      evidenceRef: `BUYER_PO:${str(q._id)}:r${Number.isInteger(q.revision) ? q.revision : 1}`,
      kind: "BUYER_PO",
      buyerApprovalRef: str(q._id),
      approvalRevision: Number.isInteger(q.revision) ? q.revision : null,
      approvedAt: q.customerApproval.approvedAt || null,
      poNumber: str(q.poProof.poNumber),
      poDate: q.poProof.poDate || null,
      documentRef: documentRef(q.poProof),
      documentName: str(q.poProof.name),
    }));
}

/**
 * A genuine company order's own authority.
 *
 * Offered only when the order IS an internal order — marked as one, with the
 * date that marking happened — and the approved round carries a named Sales
 * approver. A customer's order that Sales pushed through without the
 * customer's approval is not this: `isInternalOrder` is false there, a real
 * buyer exists and has not answered, and the line stays UNKNOWN.
 */
function internalAuthorisations(request, item = null) {
  if (request?.isInternalOrder !== true || !request?.internalOrderMarkedAt) return [];
  return (request.quotations || [])
    .filter((q) => str(q?.status) === "sales_approved" && str(q?.salesApproval?.approvedBy))
    .filter((q) => roundCoversLine(q, item, request))
    .map((q) => ({
      evidenceRef: `INTERNAL_ORDER:${str(q._id)}:r${Number.isInteger(q.revision) ? q.revision : 1}`,
      kind: "INTERNAL_ORDER",
      buyerApprovalRef: str(q._id),
      approvalRevision: Number.isInteger(q.revision) ? q.revision : null,
      authorisedById: q.salesApproval.approvedBy,
      authorisedAt: q.salesApproval.approvedAt || null,
      internalOrderMarkedAt: request.internalOrderMarkedAt,
    }));
}

/** Every authority a definite answer on this line may cite, of either kind. */
const evidenceOptions = (request, item = null) => [
  ...buyerApprovals(request, item),
  ...internalAuthorisations(request, item),
];

const rowLabel = (r, i) => (r?.process === "OTHER" && str(r?.otherLabel)
  ? `"${str(r.otherLabel)}"` : str(r?.process) || `Process ${i + 1}`);

/**
 * Validate a statement from the issue body and resolve its evidence against
 * the order. Returns the subdocument the version freezes, or `undefined` when
 * the body carries none (the line then states nothing — never "not required").
 *
 * @param input    `body.processRequirements`
 * @param request  the owned CustomerRequest, as the producer loaded it
 * @param actor    `{ id, name }` — stamped, never read from the body
 */
function normaliseStatement(input, request, { item = null, actor = null, now = new Date() } = {}) {
  if (input === undefined || input === null) return undefined;
  if (typeof input !== "object" || Array.isArray(input)) {
    throw fail("VALIDATION", "The process requirement must state each process.", { field: "processRequirements" });
  }
  const extra = Object.keys(input).filter((k) => !STATEMENT_FIELDS.includes(k));
  if (extra.length) {
    throw fail("FIELD_NOT_ACCEPTED", `"${extra[0]}" is not part of a process requirement.`, { field: `processRequirements.${extra[0]}` });
  }
  const rows = input.processes;
  if (!Array.isArray(rows) || !rows.length) {
    throw fail("VALIDATION", "State embroidery, printing and washing — each as required, not required or unknown.",
      { field: "processRequirements.processes" });
  }

  const approvals = new Map(evidenceOptions(request, item).map((a) => [a.evidenceRef, a]));
  const seen = new Set();
  const otherLabels = new Set();
  let others = 0;

  const out = rows.map((r, i) => {
    const field = `processRequirements.processes[${i}]`;
    if (!r || typeof r !== "object" || Array.isArray(r)) {
      throw fail("VALIDATION", `Process ${i + 1} is not a process requirement.`, { field });
    }
    const unknownKey = Object.keys(r).find((k) => !ROW_FIELDS.includes(k));
    if (unknownKey) {
      throw fail("FIELD_NOT_ACCEPTED", `"${unknownKey}" is not part of a process requirement.`, { field: `${field}.${unknownKey}` });
    }
    const process = str(r.process);
    if (!PROCESSES.includes(process)) {
      throw fail("VALIDATION", `Process ${i + 1} must be one of ${PROCESSES.join(", ")}.`, { field: `${field}.process` });
    }
    const requirement = str(r.requirement);
    if (!REQUIREMENTS.includes(requirement)) {
      throw fail("VALIDATION", `${rowLabel(r, i)} must be REQUIRED, NOT_REQUIRED or UNKNOWN — it is never assumed.`,
        { field: `${field}.requirement` });
    }

    let otherLabel = "";
    if (process === "OTHER") {
      otherLabel = str(r.otherLabel).replace(/\s+/g, " ");
      if (!otherLabel) throw fail("VALIDATION", "Say what the other process is.", { field: `${field}.otherLabel` });
      if (otherLabel.length > LIMITS.OTHER_LABEL) {
        throw fail("VALIDATION", `An other process is named in at most ${LIMITS.OTHER_LABEL} characters.`, { field: `${field}.otherLabel` });
      }
      const key = otherLabel.toLowerCase();
      if (otherLabels.has(key)) throw fail("VALIDATION", `"${otherLabel}" is stated twice.`, { field: `${field}.otherLabel` });
      otherLabels.add(key);
      if (++others > LIMITS.OTHERS) throw fail("VALIDATION", `At most ${LIMITS.OTHERS} other processes.`, { field });
    } else {
      if (str(r.otherLabel)) throw fail("VALIDATION", "Only an OTHER process carries a label.", { field: `${field}.otherLabel` });
      if (seen.has(process)) {
        throw fail("VALIDATION", `${process} is stated twice. State each process once.`, { field: `${field}.process` });
      }
      seen.add(process);
    }

    const specification = str(r.buyerSpecification).replace(/\s+/g, " ");
    if (specification.length > LIMITS.SPECIFICATION) {
      throw fail("VALIDATION", `A buyer specification is at most ${LIMITS.SPECIFICATION} characters.`, { field: `${field}.buyerSpecification` });
    }

    if (!DEFINITE.includes(requirement)) {
      /* UNKNOWN is an honest answer and rests on nothing, so it cites nothing. */
      if (str(r.evidenceRef)) {
        throw fail("VALIDATION", `${rowLabel(r, i)} is UNKNOWN, so it cannot cite a buyer approval.`, { field: `${field}.evidenceRef` });
      }
      return { process, otherLabel, requirement, buyerSpecification: specification };
    }

    const ref = str(r.evidenceRef);
    if (!ref) {
      throw fail("PROCESS_REQUIREMENT_EVIDENCE_REQUIRED",
        `${rowLabel(r, i)} is ${requirement === "REQUIRED" ? "required" : "not required"} only on somebody's word — `
        + "name the buyer-approved purchase order it rests on (or, on a company order, the Sales authorisation), "
        + "or state it UNKNOWN.",
        { field: `${field}.evidenceRef` });
    }
    const evidence = approvals.get(ref);
    if (!evidence) {
      throw fail("PROCESS_REQUIREMENT_EVIDENCE_REQUIRED",
        "That buyer approval is not one this line can rest on. Only a quotation round the customer approved, covering this line, with its own purchase order uploaded, counts.",
        { field: `${field}.evidenceRef` });
    }
    if (!specification) {
      throw fail("VALIDATION",
        evidence.kind === "INTERNAL_ORDER"
          ? `Say what was decided for ${rowLabel(r, i)} on this company order.`
          : `Say what the buyer approved for ${rowLabel(r, i)}, in their document's terms.`,
        { field: `${field}.buyerSpecification` });
    }

    /* A company order has no buyer to point at, so the authority is a named
       Sales approver plus a reason — said here, by the person issuing it. */
    const reason = str(r.authorisationReason).replace(/\s+/g, " ");
    if (evidence.kind !== "INTERNAL_ORDER") {
      if (reason) {
        throw fail("VALIDATION", "A buyer-approved answer rests on the buyer's document, not on an authorisation reason.",
          { field: `${field}.authorisationReason` });
      }
    } else if (reason.length < REASON_MIN) {
      throw fail("PROCESS_REQUIREMENT_EVIDENCE_REQUIRED",
        `${rowLabel(r, i)} is authorised by Sales on a company order — say why, in at least ${REASON_MIN} characters.`,
        { field: `${field}.authorisationReason` });
    }

    const { evidenceRef: _ignored, ...frozen } = evidence;
    return { process, otherLabel, requirement, buyerSpecification: specification,
      evidence: { ...frozen, ...(reason ? { reason } : {}) } };
  });

  const missing = CORE_PROCESSES.filter((p) => !seen.has(p));
  if (missing.length) {
    throw fail("VALIDATION",
      `State ${missing.map((p) => p.toLowerCase()).join(", ")} as well — required, not required or unknown. Silence is never "not required".`,
      { field: "processRequirements.processes", missing });
  }

  return {
    processes: out,
    statedAt: now,
    statedBy: actor?.id ? { id: actor.id, name: str(actor.name) } : undefined,
  };
}

/** The statement as a screen may show it. */
function statementView(stored) {
  if (!stored || !Array.isArray(stored.processes)) return null;
  return {
    statedAt: stored.statedAt || null,
    statedByName: str(stored.statedBy?.name),
    processes: stored.processes.map((p) => ({
      process: str(p.process),
      otherLabel: str(p.otherLabel),
      requirement: str(p.requirement),
      buyerSpecification: str(p.buyerSpecification),
      evidence: p.evidence ? {
        kind: str(p.evidence.kind), label: evidenceLabel(p.evidence.kind),
        buyerApprovalRef: str(p.evidence.buyerApprovalRef), approvalRevision: p.evidence.approvalRevision ?? null,
        approvedAt: p.evidence.approvedAt || null, poNumber: str(p.evidence.poNumber),
        poDate: p.evidence.poDate || null, documentName: str(p.evidence.documentName),
        authorisedById: p.evidence.authorisedById ? str(p.evidence.authorisedById) : null,
        authorisedAt: p.evidence.authorisedAt || null, reason: str(p.evidence.reason),
      } : null,
    })),
  };
}

const evidenceLabel = (kind) => (str(kind) === "INTERNAL_ORDER"
  ? "Company order — Sales-authorised, no buyer PO"
  : "Buyer-approved order (PO)");

module.exports = {
  CORE_PROCESSES, PROCESSES, REQUIREMENTS, DEFINITE, LIMITS, ROW_FIELDS, REASON_MIN,
  buyerApprovals, internalAuthorisations, evidenceOptions, evidenceLabel, roundCoversLine,
  normaliseStatement, statementView,
};

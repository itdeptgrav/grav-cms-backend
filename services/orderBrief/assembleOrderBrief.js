"use strict";
/**
 * services/orderBrief/assembleOrderBrief.js
 * ───────────────────────────────────────────────────────────────────────────
 * THE BUYER-APPROVED ORDER BRIEF, ASSEMBLED FROM RECORDS THAT ALREADY EXIST.
 *
 * Pure. It receives the source records already loaded (and already proved to
 * belong to the caller's company — see orderBrief.service.js) and returns the
 * brief. It writes nothing, stores nothing and keeps no copy: every value it
 * shows is read from the record that owns it, and every value says which
 * record that was. A second editable copy of an order's instructions would be
 * a second place for them to be wrong.
 *
 * ── WHAT "BUYER-APPROVED" CAN AND CANNOT MEAN HERE ─────────────────────────
 * The buyer's own acts are recorded in exactly three places: the quotation's
 * acceptance (with the PO proof taken at that moment), the journey's recorded
 * PO, and the sample style's `customerApproval`. Everything else is somebody
 * inside the company confirming an instruction — Sales issuing a handover,
 * Merchandising approving a trim list, R&D approving a tech pack. Those are
 * real confirmations and are shown as such, under their own names. They are
 * never relabelled as the buyer's.
 *
 * Sample ROUND outcomes are Sales' internal verdicts, not the buyer's, and are
 * never read as buyer approval. Account `garmentSalesProfile` values are the
 * buyer's standing defaults, not this order's agreement, and can only ever be
 * a draft here.
 *
 * ── HOW AN OLDER HANDOVER IS INVALIDATED ───────────────────────────────────
 * No model stores a fingerprint of what a handover was issued against, and a
 * newer approval sets no stale flag anywhere. So it is computed, and it
 * is computed as TWO different answers:
 *
 *   INVALIDATED — an APPROVAL moved after the handover was issued: the
 *   quotation was accepted again, or stopped being accepted; the buyer's
 *   sample decision was recorded again; the tech pack was approved again. The
 *   approved order the handover described no longer exists as it did, so
 *   every fact the brief took from that handover is demoted to draft, with the
 *   reason written beside it.
 *
 *   DIVERGED — the editable order record no longer matches what the handover
 *   froze (its quantity, its style), but no approval stands behind the edit.
 *   That is shown as a warning, loudly, and demotes nothing: an unapproved
 *   edit to the order book is not a change to an approved instruction, and
 *   treating it as one would let anybody with edit access silently void a
 *   handover the buyer's acceptance still supports.
 */

const {
  STATUS,
  AUTHORITY,
  source,
  candidate,
  resolve,
  tally,
  fingerprintOf,
  str,
  iso,
} = require("./facts");

/* A quotation the buyer has accepted. `sales_approved` is later on the same
   ladder — it presupposes acceptance (or Sales' explicit acknowledgement of
   its absence, recorded in `customerApproval` by the approve route). */
const ACCEPTED_QUOTATION = Object.freeze(["customer_approved", "sales_approved"]);

const HANDOVER_STATE = Object.freeze({
  NOT_ISSUED: "not_issued",
  CURRENT: "current",
  CANCELLED: "cancelled",
  NO_LINE_REF: "no_line_ref",
});

const STALE = Object.freeze({
  ORDER_QUANTITY_CHANGED: "ORDER_QUANTITY_CHANGED",
  STYLE_CHANGED: "STYLE_CHANGED",
  QUOTATION_EDITED: "QUOTATION_EDITED",
  QUOTATION_REAPPROVED: "QUOTATION_REAPPROVED",
  QUOTATION_NOT_ACCEPTED: "QUOTATION_NOT_ACCEPTED",
  SAMPLE_DECISION_CHANGED: "SAMPLE_DECISION_CHANGED",
  TECH_PACK_REAPPROVED: "TECH_PACK_REAPPROVED",
});

const time = (d) => {
  if (!d) return null;
  const t = new Date(d).getTime();
  return Number.isNaN(t) ? null : t;
};
const fmtDate = (d) => (iso(d) ? iso(d).slice(0, 10) : "an unknown date");
const num = (v) => (v === null || v === undefined || v === "" || Number.isNaN(Number(v)) ? null : Number(v));
const nonEmpty = (arr) => Array.isArray(arr) && arr.length > 0;

/** Attribute pairs as plain data, in a stable order. */
function attributesOf(list) {
  return (Array.isArray(list) ? list : [])
    .map((a) => ({ name: str(a?.name), value: str(a?.value) }))
    .filter((a) => a.name || a.value);
}

/* ═══════════════════════════════════════════════════════════════════════════
 * THE COMMERCIAL BASIS: WHICH QUOTATION, WHICH PO
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * The quotation the buyer accepted, if one stands.
 *
 * `quotations[0]` is always the current round. A round that was accepted and
 * then revised is archived whole into `quotationRevisions[]`, so "the buyer
 * accepted revision 2, revision 3 is a draft" is a real and common state — and
 * in it, the accepted commercial basis is under revision, not settled.
 */
function quotationBasis(request) {
  const current = request?.quotations?.[0] || null;
  if (current && ACCEPTED_QUOTATION.includes(current.status)) {
    return { accepted: current, current, underRevision: false, previouslyAccepted: null };
  }
  const archived = Array.isArray(request?.quotationRevisions) ? request.quotationRevisions : [];
  const previouslyAccepted = archived
    .filter((q) => ACCEPTED_QUOTATION.includes(q?.status))
    .reduce((best, q) => ((num(q.revision) ?? -1) > (num(best?.revision) ?? -1) ? q : best), null);
  return {
    accepted: null,
    current,
    /* Only a round in preparation is a revision "in progress". A rejected or
       expired current round is a different, sadder fact, and saying it is
       being revised would be untrue. */
    underRevision: !!previouslyAccepted && ["draft", "sent_to_customer"].includes(current?.status),
    previouslyAccepted,
  };
}

/** When the accepted quotation was last approved — by the buyer or by Sales. */
function acceptedAt(quotation) {
  if (!quotation) return null;
  const times = [quotation.customerApproval?.approvedAt, quotation.salesApproval?.approvedAt]
    .map(time)
    .filter((t) => t !== null);
  return times.length ? new Date(Math.max(...times)) : null;
}

/* ── WAS THE QUOTATION CHANGED AFTER THE BUYER ACCEPTED IT? ───────────────
 * The false-confirmation risk this exists for: `POST /requests/:id/quotation`
 * (quotationRoutes.js) rewrites items, prices and totals on the CURRENT round
 * with `Object.assign` and no status guard, so an accepted — even
 * sales-approved — quotation can be edited in place with no new buyer
 * approval. Nothing anywhere keeps a copy of what the buyer accepted.
 *
 * The only trace an edit leaves is the round's `updatedAt`. It is not an
 * edit timestamp — sales approval, the accountant, and every payment and
 * payment submission bump it too — so it is read as a ladder of THREE answers,
 * and only the first may make a figure buyer-confirmed:
 *
 *   unchanged   — nothing touched the round after the buyer accepted it.
 *                 Its figures are, provably, the ones accepted.
 *   edited      — it was modified after acceptance and none of the writes
 *                 that are not content edits accounts for that modification.
 *                 Positive evidence of an edit: needs the buyer again.
 *   unprovable  — it was modified after acceptance, but the last
 *                 modification coincides with a known non-content write (most
 *                 often Sales' own approval). That explains the LAST write,
 *                 not the ones before it, so an edit cannot be ruled out.
 *
 * A write and its `updatedAt` land within milliseconds; five seconds absorbs
 * clock and save latency without swallowing a genuine later edit. */
const SAME_WRITE_MS = 5000;

function contentEvidence(q) {
  if (!q) return { state: "unprovable", acceptedAt: null, lastModifiedAt: null, explainedBy: null };
  const accepted = time(q.customerApproval?.approvedAt) ?? time(q.salesApproval?.approvedAt);
  const modified = time(q.updatedAt);
  const out = (state, explainedBy = null) => ({
    state,
    acceptedAt: accepted === null ? null : iso(new Date(accepted)),
    lastModifiedAt: modified === null ? null : iso(new Date(modified)),
    explainedBy,
  });
  if (accepted === null || modified === null) return out("unprovable");
  if (modified <= accepted + SAME_WRITE_MS) return out("unchanged");

  /* Every write to a round that is NOT a content edit and leaves a timestamp
     of its own (CustomerRequest.js quotation, payment and approval schemas). */
  const events = [
    ["Sales' approval", q.salesApproval?.approvedAt],
    ["sending to the buyer", q.sentToCustomerAt],
    ["a rejection", q.rejectedAt],
    ["the accountant's approval", q.accountantApproval?.approvedAt],
    ...(q.accountantApproval?.approvalHistory || []).map((h) => ["the accountant's approval", h?.actionAt]),
    ...(q.paymentSchedule || []).map((p) => ["a payment", p?.paidDate]),
    ...(q.paymentSubmissions || []).flatMap((x) => [
      ["a payment submission", x?.submissionDate],
      ["a payment submission", x?.verifiedAt],
      ["a payment submission", x?.recordedAt],
      ["a payment submission", x?.createdAt],
      ["a payment submission", x?.updatedAt],
    ]),
  ]
    .map(([what, at]) => [what, time(at)])
    .filter(([, t]) => t !== null && t > accepted);

  const explained = events.find(([, t]) => Math.abs(modified - t) <= SAME_WRITE_MS);
  return explained ? out("unprovable", explained[0]) : out("edited");
}

/** What a reader is told about a figure the ladder could not confirm. */
function evidenceNote(ev, what) {
  if (ev.state === "edited") {
    return `The quotation was changed on ${fmtDate(ev.lastModifiedAt)}, after the buyer accepted it on ${fmtDate(ev.acceptedAt)}, and no new buyer approval is recorded. This ${what} needs the buyer's reconfirmation.`;
  }
  return `The quotation was last written by ${ev.explainedBy || "an unrecorded change"} on ${fmtDate(ev.lastModifiedAt)}, after the buyer accepted it on ${fmtDate(ev.acceptedAt)}. An accepted quotation can be edited without a new approval and nothing keeps the accepted version, so this ${what} cannot be proved to be the one the buyer accepted.`;
}

/* What a quotation line may show. Deliberately NOT `costingSource`, and never
   the order line's `commercialDecision` — floor price, costing version and the
   below-floor exception are internal and the model says so. */
function quotationLineView(it) {
  return {
    itemName: str(it?.itemName) || null,
    itemCode: str(it?.itemCode) || null,
    productLineRef: str(it?.productLineRef) || null,
    sampleStyleId: it?.sampleStyleId ? String(it.sampleStyleId) : null,
    quantity: num(it?.quantity),
    unitPrice: num(it?.unitPrice),
    priceIncludingGST: num(it?.priceIncludingGST),
    attributes: attributesOf(it?.attributes),
  };
}

/* ── THE ACCEPTANCE, NOT THE FIGURES ──────────────────────────────────────
 * That the buyer accepted revision N on a date is a fact no later edit can
 * undo, so it can stand confirmed. The FIGURES on that round can be edited
 * afterwards, so they are NOT carried here; they are separate facts
 * (`acceptedTotal`, each line's `quantity` and `price`) that must pass the
 * content-evidence ladder on their own. Carrying them inside this fact is
 * exactly how an edited total used to inherit a buyer-confirmed label. */
function quotationView(q) {
  return {
    quotationNumber: str(q.quotationNumber) || null,
    revision: num(q.revision),
    status: q.status || null,
    validUntil: iso(q.validUntil),
    customerApprovedAt: iso(q.customerApproval?.approvedAt),
    salesApprovedAt: iso(q.salesApproval?.approvedAt),
  };
}

function acceptedQuotationFact(basis) {
  const cands = [];
  const q = basis.accepted;

  if (q) {
    const onBehalf = !q.customerApproval?.approvedBy
      && /^\s*\[On Behalf by Sales\]/i.test(str(q.customerApproval?.notes));
    const ev = contentEvidence(q);
    cands.push(candidate({
      status: STATUS.CONFIRMED,
      authority: AUTHORITY.BUYER,
      value: { ...quotationView(q), contentSinceAcceptance: ev.state },
      source: source({
        kind: "quotation",
        ref: q.quotationNumber,
        version: num(q.revision),
        at: acceptedAt(q),
      }),
      note: [
        onBehalf ? "Acceptance was recorded by Sales on the buyer's behalf, against the PO proof." : "",
        ev.state === "edited"
          ? `The quotation has been changed since (${fmtDate(ev.lastModifiedAt)}); its current figures are not confirmed.`
          : "",
      ].filter(Boolean).join(" "),
    }));
  } else if (basis.underRevision) {
    const p = basis.previouslyAccepted;
    cands.push(candidate({
      status: STATUS.DRAFT,
      authority: AUTHORITY.BUYER,
      value: quotationView(p),
      source: source({ kind: "quotation_revision", ref: p.quotationNumber, version: num(p.revision), at: acceptedAt(p) }),
      note: `The buyer accepted revision ${num(p.revision) ?? "?"}, but revision ${num(basis.current.revision) ?? "?"} is now being prepared (${basis.current.status}). Until it is accepted there is no settled commercial basis.`,
    }));
  } else if (basis.current && ["draft", "sent_to_customer"].includes(basis.current.status)) {
    cands.push(candidate({
      status: STATUS.DRAFT,
      authority: AUTHORITY.SALES,
      value: quotationView(basis.current),
      source: source({ kind: "quotation", ref: basis.current.quotationNumber, version: num(basis.current.revision) }),
      note: basis.current.status === "sent_to_customer"
        ? "Sent to the buyer; not accepted yet."
        : "A draft quotation; not sent to the buyer.",
    }));
  }

  return resolve({
    key: "acceptedQuotation",
    label: "Accepted quotation",
    candidates: cands,
    missingNote: basis.current
      ? `The latest quotation is ${basis.current.status}; no quotation stands accepted.`
      : "No quotation has been raised on this order.",
  });
}

/* Rupees, to the paisa: a GST rounding difference is not a different total. */
const sameMoney = (a, b) => a !== null && b !== null && Math.abs(a - b) < 1;

/**
 * The total the buyer committed to.
 *
 * Two witnesses, and neither is trusted further than it can be:
 *
 *   the quotation's total  — buyer-confirmed only while the round is provably
 *                            unchanged since acceptance (see contentEvidence).
 *   the PO's recorded value — `poProof.poValue`, taken from the buyer's own
 *                            PO at the acceptance act and written only if
 *                            empty. It is the independent corroboration: an
 *                            edited quotation whose total still matches the
 *                            buyer's PO has not changed what the buyer pays.
 *
 * When both are confirmed they must agree, or the resolver refuses both. When
 * an edit has moved the quotation's total, the PO's figure stands and the
 * edited one waits for the buyer.
 */
function acceptedTotalFact(basis) {
  const cands = [];
  const q = basis.accepted;
  if (q) {
    const ev = contentEvidence(q);
    const total = num(q.grandTotal);
    const src = source({ kind: "quotation", ref: q.quotationNumber, version: num(q.revision), at: acceptedAt(q) });
    if (total !== null) {
      cands.push(ev.state === "unchanged"
        ? candidate({
            status: STATUS.CONFIRMED, authority: AUTHORITY.BUYER, claim: "total",
            value: { grandTotal: total }, comparable: Math.round(total), source: src,
          })
        : candidate({
            status: STATUS.DRAFT, authority: AUTHORITY.BUYER, claim: "total",
            value: { grandTotal: total }, comparable: Math.round(total), source: src,
            needsReconfirmation: ev.state === "edited",
            note: evidenceNote(ev, "total"),
          }));
    }
    const poValue = num(q.poProof?.poValue);
    if (poValue !== null && poValue > 0) {
      cands.push(candidate({
        status: STATUS.CONFIRMED, authority: AUTHORITY.BUYER, claim: "total",
        value: { grandTotal: poValue },
        comparable: Math.round(poValue),
        source: source({ kind: "quotation_po_proof", ref: q.poProof?.poNumber || q.quotationNumber, at: q.poProof?.uploadedAt }),
        note: total !== null && sameMoney(total, poValue)
          ? "Matches the value on the buyer's PO."
          : "The value on the buyer's PO.",
      }));
    }
  } else if (basis.current) {
    const total = num(basis.current.grandTotal);
    if (total !== null) {
      cands.push(candidate({
        status: STATUS.DRAFT, authority: AUTHORITY.SALES, claim: "total",
        value: { grandTotal: total },
        source: source({ kind: "quotation", ref: basis.current.quotationNumber, version: num(basis.current.revision) }),
        note: "The current quotation's total; no quotation stands accepted.",
      }));
    }
  }
  return resolve({
    key: "acceptedTotal",
    label: "Accepted total",
    candidates: cands,
    missingNote: "No accepted total is recorded.",
  });
}

/** A PO number, normalised only enough to compare two records of the same PO. */
const poKey = (v) => str(v).toUpperCase().replace(/\s+/g, "");

/**
 * The buyer's PO. It has two homes that nothing reconciles:
 *
 *   1. `quotations[0].poProof` — taken at the acceptance act itself; the
 *      Sales approve routes refuse without it. Ranked first.
 *   2. `SalesJourney.po` — recorded on the journey, replaced wholesale on every
 *      edit.
 *
 * Either counts as confirmed only when it is EVIDENCED — a number and a
 * document. A typed number with nothing behind it is a draft. And if both
 * homes carry a number and the numbers differ, the resolver's conflict rule
 * applies: two confirmed records of different POs are not an agreed PO.
 */
function purchaseOrderFact(basis, journey) {
  const cands = [];
  /* A PO taken when a round was accepted stays the buyer's PO while a later
     round is prepared — revising the price does not un-issue their order. */
  const q = basis.accepted || basis.previouslyAccepted || basis.current;
  const proof = q?.poProof || null;

  if (proof && (str(proof.poNumber) || str(proof.url) || str(proof.fileId))) {
    const evidenced = !!str(proof.poNumber) && !!(str(proof.url) || str(proof.fileId));
    const onAccepted = !!basis.accepted || q === basis.previouslyAccepted;
    cands.push(candidate({
      status: evidenced && onAccepted ? STATUS.CONFIRMED : STATUS.DRAFT,
      authority: AUTHORITY.BUYER,
      value: {
        poNumber: str(proof.poNumber) || null,
        poDate: iso(proof.poDate),
        poValue: num(proof.poValue),
        document: str(proof.url) ? { name: str(proof.name) || null, url: str(proof.url) } : null,
      },
      comparable: poKey(proof.poNumber),
      source: source({ kind: "quotation_po_proof", ref: q.quotationNumber, version: num(q.revision), at: proof.uploadedAt }),
      note: !onAccepted
        ? "Attached to a quotation that is not accepted."
        : !evidenced
          ? "A PO number with no document behind it, or a document with no number."
          : q === basis.previouslyAccepted
            ? `Recorded when revision ${num(q.revision) ?? "?"} was accepted; the quotation is now being revised.`
            : "",
    }));
  }

  const po = journey?.po || null;
  if (po && (str(po.number) || str(po.file?.url))) {
    const evidenced = !!str(po.number) && !!str(po.file?.url);
    cands.push(candidate({
      status: evidenced ? STATUS.CONFIRMED : STATUS.DRAFT,
      authority: AUTHORITY.BUYER,
      value: {
        poNumber: str(po.number) || null,
        poDate: iso(po.date),
        poValue: num(po.amount),
        currency: str(po.currency) || null,
        document: str(po.file?.url) ? { name: str(po.file?.name) || null, url: str(po.file.url) } : null,
      },
      comparable: poKey(po.number),
      source: source({ kind: "journey_po", ref: journey.journeyId, at: po.recordedAt, by: po.recordedBy?.name }),
      note: evidenced ? "" : "A PO number recorded with no document attached.",
    }));
  }

  return resolve({
    key: "purchaseOrder",
    label: "Buyer purchase order",
    candidates: cands,
    missingNote: "No PO has been recorded against this order.",
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
 * THE HANDOVER: WHICH VERSION, AND IS IT STILL TRUE
 * ══════════════════════════════════════════════════════════════════════════ */

/** The handover picture for one line, before staleness is judged. */
function handoverFor(lineRef, versions, files) {
  if (!lineRef) return { state: HANDOVER_STATE.NO_LINE_REF, current: null, history: [], file: null };

  const mine = (versions || [])
    .filter((v) => str(v.handoverLineRef) === lineRef)
    .sort((a, b) => (num(a.versionNo) || 0) - (num(b.versionNo) || 0));
  const current = mine.find((v) => v.publication?.state === "CURRENT") || null;
  const latest = mine[mine.length - 1] || null;

  const file = (files || []).find((f) => str(f.handoverLineRef) === lineRef) || null;

  let state = HANDOVER_STATE.NOT_ISSUED;
  if (current) state = HANDOVER_STATE.CURRENT;
  else if (latest?.publication?.state === "CANCELLED") state = HANDOVER_STATE.CANCELLED;

  return { state, current, history: mine, file };
}

/**
 * Has anything the handover depended on moved since it was issued?
 *
 * Returns two lists — see the header for why they are different claims.
 *
 * `reasons` (invalidating) come from APPROVAL timelines: each compares when an
 * approval was last made against when the handover was issued.
 *
 * `divergences` (warning only) compare the editable order line with what the
 * handover froze. Only fields the issue actually READ from the order line are
 * compared — its total quantity and its style (merchandisingHandover.service
 * `issue()`). The breakdown, deliveries and requirement texts were typed by
 * Sales at issue, so there is no order field they could drift from.
 */
function staleReasons({ current, item, basis, style, techApproved }) {
  if (!current) return { reasons: [], divergences: [] };
  const issuedAt = time(current.sourceRecord?.issuedAt) ?? time(current.createdAt);
  const p = current.executionProjection || {};
  const reasons = [];
  const divergences = [];

  const orderQty = num(item?.totalQuantity);
  const frozenQty = num(p.totalQuantity);
  if (orderQty !== null && frozenQty !== null && orderQty !== frozenQty) {
    divergences.push({
      code: STALE.ORDER_QUANTITY_CHANGED,
      message: `The order line now says ${orderQty} pieces, but handover version ${current.versionNo} was issued for ${frozenQty} and no re-approval stands behind the change. Either the edit is wrong, or the quotation needs accepting again and the handover reissuing.`,
    });
  }

  if (p.sampleStyleId && item?.sampleStyleId && String(p.sampleStyleId) !== String(item.sampleStyleId)) {
    divergences.push({
      code: STALE.STYLE_CHANGED,
      message: `The order line now names a different style from the one handover version ${current.versionNo} was issued for, and no re-approval stands behind the change.`,
    });
  }

  if (!basis.accepted) {
    reasons.push({
      code: STALE.QUOTATION_NOT_ACCEPTED,
      message: basis.underRevision
        ? `The quotation is being revised (revision ${num(basis.current?.revision) ?? "?"} is ${basis.current?.status}); handover version ${current.versionNo} was issued against an accepted quotation.`
        : `No quotation stands accepted now; handover version ${current.versionNo} was issued against one.`,
    });
  } else {
    const at = time(acceptedAt(basis.accepted));
    if (issuedAt !== null && at !== null && at > issuedAt) {
      reasons.push({
        code: STALE.QUOTATION_REAPPROVED,
        message: `The quotation was accepted again on ${fmtDate(new Date(at))}, after handover version ${current.versionNo} was issued on ${fmtDate(new Date(issuedAt))}.`,
      });
    }
  }

  if (style) {
    const decisions = [style.customerApproval?.decidedAt, ...((style.customerApproval?.log) || []).map((l) => l?.decidedAt)]
      .map(time).filter((t) => t !== null);
    const lastDecision = decisions.length ? Math.max(...decisions) : null;
    if (issuedAt !== null && lastDecision !== null && lastDecision > issuedAt) {
      reasons.push({
        code: STALE.SAMPLE_DECISION_CHANGED,
        message: `The buyer's sample decision was recorded again on ${fmtDate(new Date(lastDecision))}, after handover version ${current.versionNo} was issued.`,
      });
    }
  }

  const techAt = time(techApproved?.decidedAt);
  if (issuedAt !== null && techAt !== null && techAt > issuedAt) {
    reasons.push({
      code: STALE.TECH_PACK_REAPPROVED,
      message: `The tech pack was approved again (revision ${techApproved.revision}) on ${fmtDate(new Date(techAt))}, after handover version ${current.versionNo} was issued.`,
    });
  }

  /* An edit is not an approval, so it cannot invalidate the handover — but a
     handover issued against figures that have since been rewritten is exactly
     the drift a reader must see. */
  if (basis.accepted) {
    const ev = contentEvidence(basis.accepted);
    const editedAt = time(ev.lastModifiedAt);
    if (ev.state === "edited" && issuedAt !== null && editedAt !== null && editedAt > issuedAt) {
      divergences.push({
        code: STALE.QUOTATION_EDITED,
        message: `The accepted quotation was changed on ${fmtDate(ev.lastModifiedAt)}, after handover version ${current.versionNo} was issued, with no new buyer approval.`,
      });
    }
  }

  return { reasons, divergences };
}

/** The handover block the brief shows for a line. */
function handoverView(h, reasons, divergences = []) {
  const c = h.current;
  const file = h.file;
  const acceptedVersionId = file?.currentHandoverVersionId ? String(file.currentHandoverVersionId) : null;
  const acceptedEntry = acceptedVersionId
    ? h.history.find((v) => String(v._id) === acceptedVersionId) || null
    : null;

  return {
    state: h.state,
    current: c
      ? {
          versionNo: num(c.versionNo),
          issuedAt: iso(c.sourceRecord?.issuedAt || c.createdAt),
          issuedBy: str(c.issuedBy?.name) || null,
        }
      : null,
    history: h.history.map((v) => ({
      versionNo: num(v.versionNo),
      state: v.publication?.state || null,
      issuedAt: iso(v.sourceRecord?.issuedAt || v.createdAt),
      supersededAt: iso(v.publication?.supersededAt),
      cancelledAt: iso(v.publication?.cancelledAt),
    })),
    merchandising: file
      ? {
          fileNumber: str(file.fileNumber) || null,
          acceptedVersionNo: acceptedEntry ? num(acceptedEntry.versionNo) : null,
          /* Merchandising accepts a newer version by hand; until then it is
             working from the older one, and nothing on its side says so. */
          workingFromOlderVersion: !!(c && acceptedVersionId && acceptedVersionId !== String(c._id)),
        }
      : null,
    stale: reasons.length > 0,
    staleReasons: reasons,
    divergences,
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
 * ONE ORDER LINE
 * ══════════════════════════════════════════════════════════════════════════ */

/** The accepted quotation line for an order line, matched by id, never by name. */
function quotationLineFor(item, quotation) {
  if (!quotation) return null;
  const lines = quotation.items || [];
  const byRef = str(item.productLineRef);
  if (byRef) {
    const hit = lines.filter((l) => str(l.productLineRef) === byRef);
    if (hit.length === 1) return hit[0];
  }
  for (const [field, want] of [["sampleStyleId", item.sampleStyleId], ["stockItemId", item.stockItemId]]) {
    if (!want) continue;
    const hit = lines.filter((l) => l[field] && String(l[field]) === String(want));
    /* Ambiguity is an answer: two accepted lines for one style mean the match
       would be a guess, and a guessed quantity is worse than none. */
    if (hit.length === 1) return hit[0];
  }
  return null;
}

function handoverSource(current) {
  return source({
    kind: "sales_handover",
    ref: `${str(current.handoverRef)} · ${str(current.handoverLineRef)}`,
    version: num(current.versionNo),
    at: current.sourceRecord?.issuedAt || current.createdAt,
    by: current.issuedBy?.name,
  });
}

/**
 * A handover-sourced candidate, demoted when the handover is out of date.
 *
 * The handover is issued as one unit. If it no longer describes the approved
 * order, none of its content is the current instruction — including parts
 * (a packing note) that the change did not touch — because nobody has
 * re-confirmed them against the order as it now stands.
 */
function fromHandover(current, stale, { value, comparable, note = "", claim = "value" }) {
  return candidate({
    status: stale ? STATUS.DRAFT : STATUS.CONFIRMED,
    authority: AUTHORITY.SALES_HANDOVER,
    value,
    comparable,
    claim,
    source: handoverSource(current),
    note: stale
      ? `From handover version ${current.versionNo}, which is out of date; Sales needs to reissue it before this is an instruction.${note ? ` ${note}` : ""}`
      : note,
  });
}

function revisionSource(rev, family) {
  return source({
    kind: `merchandising_${family}`,
    ref: rev.fileId ? String(rev.fileId) : null,
    version: num(rev.revisionNo),
    at: rev.approvedAt || rev.submittedAt || rev.updatedAt || rev.createdAt,
    by: rev.approvedBy?.name || rev.submittedBy?.name || rev.createdBy?.name,
  });
}

const trimRow = (r) => ({
  group: r.group || null,
  componentName: str(r.componentName) || null,
  buyerRef: str(r.buyerRef) || null,
  colourOrShade: str(r.colourOrShade) || null,
  finish: str(r.finish) || null,
  placement: str(r.placement) || null,
  sizeOrDimension: str(r.sizeOrDimension) || null,
  specification: str(r.specification) || null,
});

const packagingRow = (r) => ({
  group: r.group || null,
  componentName: str(r.componentName) || null,
  buyerRef: str(r.buyerRef) || null,
  colourOrShade: str(r.colourOrShade) || null,
  placement: str(r.placement) || null,
  sizeOrDimension: str(r.sizeOrDimension) || null,
  specification: str(r.specification) || null,
});

const packingInstructions = (i = {}) => {
  const out = {
    foldingMethod: str(i.foldingMethod) || null,
    assortmentInstruction: str(i.assortmentInstruction) || null,
    ratioDescription: str(i.ratioDescription) || null,
    cartonMarks: str(i.cartonMarks) || null,
    additionalInstruction: str(i.additionalInstruction) || null,
  };
  return Object.values(out).some(Boolean) ? out : null;
};

/** The APPROVED revision and the newest unapproved one, for one file. */
function revisionsFor(fileId, revisions) {
  const mine = (revisions || []).filter((r) => fileId && String(r.fileId) === String(fileId));
  const approved = mine.find((r) => r.state === "APPROVED") || null;
  const pending = mine
    .filter((r) => r.state === "DRAFT" || r.state === "SUBMITTED")
    .reduce((best, r) => ((num(r.revisionNo) ?? -1) > (num(best?.revisionNo) ?? -1) ? r : best), null);
  return { approved, pending };
}

function buildLine({ item, index, ctx }) {
  const { basis, versions, files, stylesById, trimRevisions, packagingRevisions, enquiry, account, techApprovedOf } = ctx;

  const lineRef = str(item.lineRef) || null;
  const style = item.sampleStyleId ? stylesById.get(String(item.sampleStyleId)) || null : null;
  const techApproved = style ? techApprovedOf(style.techSheet || {}) : null;

  const h = handoverFor(lineRef, versions, files);
  const { reasons, divergences } = h.state === HANDOVER_STATE.CURRENT
    ? staleReasons({ current: h.current, item, basis, style, techApproved })
    : { reasons: [], divergences: [] };
  const stale = reasons.length > 0;
  const current = h.state === HANDOVER_STATE.CURRENT ? h.current : null;
  const projection = current?.executionProjection || null;

  const qLine = quotationLineFor(item, basis.accepted);
  /* One ladder reading per order: it is a fact about the round, not the line. */
  const quotationEv = basis.accepted ? contentEvidence(basis.accepted) : null;
  const quotationSrc = basis.accepted
    ? source({
        kind: "quotation",
        ref: basis.accepted.quotationNumber,
        version: num(basis.accepted.revision),
        at: acceptedAt(basis.accepted),
      })
    : null;
  const orderQty = num(item.totalQuantity)
    ?? (item.variants || []).reduce((s, v) => s + (num(v.quantity) || 0), 0);

  /* ── Quantity ─────────────────────────────────────────────────────────── */
  const quantity = resolve({
    key: "quantity",
    label: "Quantity",
    candidates: [
      projection && fromHandover(current, stale, {
        value: { totalQuantity: num(projection.totalQuantity) },
        comparable: num(projection.totalQuantity),
      }),
      qLine && (quotationEv.state === "unchanged"
        ? candidate({
            status: STATUS.CONFIRMED,
            authority: AUTHORITY.BUYER,
            value: { totalQuantity: num(qLine.quantity) },
            comparable: num(qLine.quantity),
            source: quotationSrc,
            note: "The quantity on the quotation the buyer accepted, unchanged since.",
          })
        : candidate({
            status: STATUS.DRAFT,
            authority: AUTHORITY.BUYER,
            value: { totalQuantity: num(qLine.quantity) },
            comparable: num(qLine.quantity),
            source: quotationSrc,
            needsReconfirmation: quotationEv.state === "edited",
            note: evidenceNote(quotationEv, "quantity"),
          })),
      orderQty !== null && candidate({
        status: STATUS.DRAFT,
        authority: AUTHORITY.ORDER_RECORD,
        value: { totalQuantity: orderQty },
        comparable: orderQty,
        source: source({ kind: "customer_request", ref: ctx.requestRef }),
        note: "The order line as it stands. Editable, and not confirmed by itself.",
      }),
    ],
    missingNote: "No quantity is recorded for this line.",
  });

  /* ── Sizes, colours and the split ─────────────────────────────────────── */
  const variants = (item.variants || [])
    .map((v) => ({ attributes: attributesOf(v.attributes), quantity: num(v.quantity) }))
    .filter((v) => v.attributes.length || v.quantity !== null);

  const sizes = resolve({
    key: "sizes",
    label: "Sizes, colours and quantities",
    candidates: [
      projection && nonEmpty(projection.breakdown) && fromHandover(current, stale, {
        value: {
          splits: projection.breakdown.map((b) => ({
            attributes: attributesOf(b.attributes),
            sizeRange: str(b.sizeRange) || null,
            quantity: num(b.quantity),
          })),
        },
      }),
      variants.length && candidate({
        status: STATUS.DRAFT,
        authority: AUTHORITY.ORDER_RECORD,
        value: { splits: variants },
        source: source({ kind: "customer_request", ref: ctx.requestRef }),
        note: "Variant quantities on the order line; sizes are free-form attributes, not a fixed size set.",
      }),
    ],
    missingNote: "No size or colour split is recorded for this line.",
  });

  /* ── Delivery ─────────────────────────────────────────────────────────── */
  const deadline = ctx.request?.customerInfo?.deliveryDeadline || null;
  const delivery = resolve({
    key: "delivery",
    label: "Delivery",
    candidates: [
      projection && fromHandover(current, stale, {
        value: {
          drops: (projection.deliveries || []).map((d) => ({
            dropRef: str(d.dropRef) || null,
            committedDeliveryDate: iso(d.committedDeliveryDate),
            quantity: num(d.quantity),
            targetExFactoryDate: iso(d.targetExFactoryDate),
          })),
          instructions: str(projection.deliveryRequirement) || null,
        },
      }),
      deadline && candidate({
        status: STATUS.DRAFT,
        authority: AUTHORITY.ORDER_RECORD,
        value: { deliveryDeadline: iso(deadline) },
        source: source({ kind: "customer_request", ref: ctx.requestRef }),
        note: "The order's delivery deadline — one date for the whole order, editable, and not a committed delivery schedule.",
      }),
    ],
    missingNote: "No delivery date or instruction is recorded.",
  });

  /* ── Fabric and trims ─────────────────────────────────────────────────── */
  const trims = revisionsFor(h.file?._id, trimRevisions);
  const enquiryProduct = (enquiry?.products || []).find(
    (p) => str(p.productLineRef) && str(p.productLineRef) === str(item.productLineRef),
  ) || null;
  const techMaterials = (techApproved?.snapshot?.materials || [])
    .filter((m) => !m.returnedToMaterials)
    .map((m) => ({
      name: str(m.rawItemName) || null,
      sku: str(m.rawItemSku) || null,
      specification: str(m.specification) || null,
      unit: str(m.unit) || null,
      appliesTo: m.appliesToAllVariants === false ? (m.appliesToVariantLabels || []).map(str) : "all",
    }));
  const enquiryFabric = enquiryProduct
    ? {
        fabricPreference: str(enquiryProduct.fabricPreference) || null,
        fabricComposition: str(enquiryProduct.fabricComposition) || null,
        gsm: str(enquiryProduct.gsm) || null,
        colour: str(enquiryProduct.colour) || null,
        trims: str(enquiryProduct.trims) || null,
      }
    : null;

  const fabricTrims = resolve({
    key: "fabricTrims",
    label: "Fabric and trims",
    candidates: [
      trims.approved && candidate({
        status: STATUS.CONFIRMED,
        authority: AUTHORITY.MERCHANDISING,
        claim: "order_selection",
        value: { revisionNo: num(trims.approved.revisionNo), rows: (trims.approved.rows || []).map(trimRow) },
        source: revisionSource(trims.approved, "material_trim"),
      }),
      techMaterials.length && candidate({
        status: STATUS.CONFIRMED,
        authority: AUTHORITY.RND,
        claim: "style_specification",
        value: { revision: num(techApproved.revision), materials: techMaterials },
        source: source({
          kind: "rnd_technical_record",
          ref: style?.styleCode || style?.sampleStyleId,
          version: num(techApproved.revision),
          at: techApproved.decidedAt,
          by: techApproved.decidedBy?.name,
        }),
        note: "The style's approved technical record. It specifies the style, not this order's selection.",
      }),
      trims.pending && candidate({
        status: STATUS.DRAFT,
        authority: AUTHORITY.MERCHANDISING,
        claim: "order_selection",
        value: { revisionNo: num(trims.pending.revisionNo), rows: (trims.pending.rows || []).map(trimRow) },
        source: revisionSource(trims.pending, "material_trim"),
        note: `Merchandising revision ${num(trims.pending.revisionNo)} is ${String(trims.pending.state).toLowerCase()}, not approved.`,
      }),
      enquiryFabric && Object.values(enquiryFabric).some(Boolean) && candidate({
        status: STATUS.DRAFT,
        authority: AUTHORITY.ENQUIRY,
        claim: "requirement",
        value: enquiryFabric,
        source: source({ kind: "enquiry", ref: enquiry.enquiryId }),
        note: "What the buyer asked for at enquiry. A requirement, not an approved specification.",
      }),
    ],
    missingNote: "No fabric or trim specification exists for this line.",
  });

  /* ── Approved sample ──────────────────────────────────────────────────── */
  let sample;
  if (!style) {
    sample = resolve({
      key: "sample",
      label: "Approved sample",
      candidates: [],
      missingNote: item.sampleStyleId
        ? "The style this line names could not be read."
        : "No sample style is linked to this order line.",
    });
  } else {
    const ca = style.customerApproval || {};
    const s = style.sample || {};
    const rounds = s.rounds || [];
    const lastAccepted = rounds.filter((r) => r.outcome === "accepted")
      .reduce((best, r) => ((num(r.roundNo) ?? -1) > (num(best?.roundNo) ?? -1) ? r : best), null);
    const styleRef = { sampleStyleId: str(style.sampleStyleId) || null, styleCode: str(style.styleCode) || null };
    const styleSrc = (extra = {}) => source({ kind: "sample_style", ref: style.styleCode || style.sampleStyleId, ...extra });

    const cands = [];
    if (s.status === "notApplicable") {
      cands.push(candidate({
        status: STATUS.NOT_APPLICABLE,
        authority: AUTHORITY.SALES,
        value: styleRef,
        source: styleSrc(),
        note: "Sales recorded that no sample is required for this style.",
      }));
    } else if (ca.approved === true && s.status === "approved") {
      cands.push(candidate({
        status: STATUS.CONFIRMED,
        authority: AUTHORITY.BUYER,
        value: {
          ...styleRef,
          round: lastAccepted
            ? { roundNo: num(lastAccepted.roundNo), type: lastAccepted.type || null, judgedAt: iso(lastAccepted.judgedAt) }
            : null,
          buyerNote: str(ca.note) || null,
        },
        source: styleSrc({ at: ca.decidedAt, by: ca.decidedBy?.name }),
        note: "The buyer's decision, as recorded on the style.",
      }));
    } else if (ca.approved === false) {
      /* Rejected is not "missing information" — it is a known refusal. But
         there is no approved sample, and a brief must not suggest one, so no
         candidate is offered and the missing note below says why. */
    } else {
      cands.push(candidate({
        status: STATUS.DRAFT,
        authority: AUTHORITY.SALES,
        value: styleRef,
        source: styleSrc({ at: s.approvedAt }),
        note: s.status === "approved"
          ? "Sales has approved the sample internally; the buyer's decision is not recorded."
          : `The sample is ${str(s.status) || "not started"}; no buyer decision is recorded.`,
      }));
    }

    sample = resolve({
      key: "sample",
      label: "Approved sample",
      candidates: cands,
      missingNote: ca.approved === false
        ? `The buyer rejected the sample on ${fmtDate(ca.decidedAt)}${str(ca.note) ? `: "${str(ca.note)}"` : ""}. No approved sample exists.`
        : "No approved sample exists.",
    });
  }

  /* ── Tech pack ────────────────────────────────────────────────────────── */
  let techPack;
  if (!style) {
    techPack = resolve({ key: "techPack", label: "Tech pack", candidates: [], missingNote: "No sample style is linked, so there is no tech pack to reference." });
  } else {
    const ts = style.techSheet || {};
    const cands = [];
    if (ts.status === "notApplicable") {
      cands.push(candidate({
        status: STATUS.NOT_APPLICABLE,
        authority: AUTHORITY.RND,
        value: { sampleStyleId: str(style.sampleStyleId) || null },
        source: source({ kind: "rnd_technical_record", ref: style.styleCode || style.sampleStyleId }),
        note: "R&D recorded that no tech sheet is required for this style.",
      }));
    } else if (techApproved) {
      cands.push(candidate({
        status: STATUS.CONFIRMED,
        authority: AUTHORITY.RND,
        value: {
          sampleStyleId: str(style.sampleStyleId) || null,
          styleCode: str(style.styleCode) || null,
          revision: num(techApproved.revision),
          document: str(techApproved.file?.url)
            ? { name: str(techApproved.file?.name) || null, url: str(techApproved.file.url) }
            : null,
        },
        source: source({
          kind: "rnd_technical_record",
          ref: style.styleCode || style.sampleStyleId,
          version: num(techApproved.revision),
          at: techApproved.decidedAt,
          by: techApproved.decidedBy?.name,
        }),
        /* Said every time, because "confirmed" on a buyer brief invites the
           assumption that the buyer signed it. */
        note: "Approved internally. This system records no buyer approval for tech packs.",
      }));
    } else if (ts.technical?.status || ts.file?.url) {
      cands.push(candidate({
        status: STATUS.DRAFT,
        authority: AUTHORITY.RND,
        value: {
          sampleStyleId: str(style.sampleStyleId) || null,
          styleCode: str(style.styleCode) || null,
          revision: num(ts.technical?.revision),
          document: str(ts.file?.url) ? { name: str(ts.file?.name) || null, url: str(ts.file.url) } : null,
        },
        source: source({ kind: "rnd_technical_record", ref: style.styleCode || style.sampleStyleId, version: num(ts.technical?.revision) }),
        note: `The technical record is ${str(ts.technical?.status) || str(ts.status) || "in progress"}, not approved.`,
      }));
    }
    techPack = resolve({ key: "techPack", label: "Tech pack", candidates: cands, missingNote: "No tech pack has been started for this style." });
  }

  /* ── Packing ──────────────────────────────────────────────────────────── */
  const packing = revisionsFor(h.file?._id, packagingRevisions);
  const packView = (rev) => ({
    revisionNo: num(rev.revisionNo),
    rows: (rev.rows || []).map(packagingRow),
    instructions: packingInstructions(rev.instructions),
  });
  const profile = account?.garmentSalesProfile || {};

  const packingFact = resolve({
    key: "packing",
    label: "Packing",
    candidates: [
      packing.approved && candidate({
        status: STATUS.CONFIRMED,
        authority: AUTHORITY.MERCHANDISING,
        /* The approved component list + packing method refines the handover's
           one-line packing requirement; they are not rival answers. */
        claim: "packaging_specification",
        value: packView(packing.approved),
        source: revisionSource(packing.approved, "packaging"),
      }),
      projection && str(projection.packingRequirement) && fromHandover(current, stale, {
        claim: "packing_requirement",
        value: { requirement: str(projection.packingRequirement) },
      }),
      packing.pending && candidate({
        status: STATUS.DRAFT,
        authority: AUTHORITY.MERCHANDISING,
        claim: "packaging_specification",
        value: packView(packing.pending),
        source: revisionSource(packing.pending, "packaging"),
        note: `Merchandising revision ${num(packing.pending.revisionNo)} is ${String(packing.pending.state).toLowerCase()}, not approved.`,
      }),
      str(profile.packagingManualRef) && candidate({
        status: STATUS.DRAFT,
        authority: AUTHORITY.BUYER_DEFAULT,
        value: { packagingManualRef: str(profile.packagingManualRef) },
        source: source({ kind: "crm_account", ref: account.accountId }),
        note: "The buyer's standing packaging manual — a default, not agreed for this order.",
      }),
    ],
    missingNote: "No packing instruction is recorded.",
  });

  /* ── Quality and testing ──────────────────────────────────────────────── */
  const qualityDefaults = {
    testingProtocol: str(profile.defaultTestingProtocol) || null,
    inspectionStandard: str(profile.defaultInspectionStandard) || null,
    aqlLevel: str(profile.defaultAqlLevel) || null,
    qualityManualRef: str(profile.qualityManualRef) || null,
  };
  const quality = resolve({
    key: "quality",
    label: "Quality and testing",
    candidates: [
      projection && str(projection.testingRequirement) && fromHandover(current, stale, {
        value: { requirement: str(projection.testingRequirement) },
      }),
      Object.values(qualityDefaults).some(Boolean) && candidate({
        status: STATUS.DRAFT,
        authority: AUTHORITY.BUYER_DEFAULT,
        value: qualityDefaults,
        source: source({ kind: "crm_account", ref: account.accountId }),
        note: "The buyer's standing quality defaults — not agreed for this order.",
      }),
    ],
    missingNote: "No quality or testing instruction is recorded.",
  });

  /* ── Accepted price ──────────────────────────────────────────────────────
     No per-line witness exists — the buyer's PO is recorded as one value — so
     a line's price is buyer-confirmed only while the round is provably
     unchanged, and never on the strength of the total matching. */
  const price = resolve({
    key: "price",
    label: "Accepted price",
    candidates: [
      qLine && (quotationEv.state === "unchanged"
        ? candidate({
            status: STATUS.CONFIRMED,
            authority: AUTHORITY.BUYER,
            value: { unitPrice: num(qLine.unitPrice), priceIncludingGST: num(qLine.priceIncludingGST) },
            source: quotationSrc,
          })
        : candidate({
            status: STATUS.DRAFT,
            authority: AUTHORITY.BUYER,
            value: { unitPrice: num(qLine.unitPrice), priceIncludingGST: num(qLine.priceIncludingGST) },
            source: quotationSrc,
            needsReconfirmation: quotationEv.state === "edited",
            note: evidenceNote(quotationEv, "price"),
          })),
    ],
    missingNote: basis.accepted
      ? "No line of the accepted quotation can be matched to this order line by reference or style."
      : "No quotation stands accepted.",
  });

  const facts = { quantity, price, sizes, delivery, fabricTrims, sample, techPack, packing: packingFact, quality };

  return {
    index,
    lineRef,
    product: {
      name: str(projection?.productName) || str(style?.productName) || str(item.stockItemName) || null,
      stockItemReference: str(item.stockItemReference) || null,
      styleCode: str(style?.styleCode) || null,
      sampleStyleId: item.sampleStyleId ? String(item.sampleStyleId) : null,
    },
    handover: handoverView(h, reasons, divergences),
    facts,
    summary: tally(Object.values(facts)),
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
 * ORDER-LEVEL FACTS WITH NO LINE SOURCE
 * ══════════════════════════════════════════════════════════════════════════ */

function complianceFact(account) {
  if (!account) {
    return resolve({
      key: "compliance",
      label: "Compliance and certifications",
      candidates: [],
      missingNote: "No buyer account could be proved for this order, so there are no requirements to read.",
    });
  }
  const p = account.garmentSalesProfile || {};
  const value = {
    requiredCertifications: (p.requiredCertifications || []).map(str).filter(Boolean),
    socialCompliance: (p.socialComplianceRequirements || []).map(str).filter(Boolean),
    sustainability: (p.sustainabilityRequirements || []).map(str).filter(Boolean),
    restrictedSubstances: (p.restrictedSubstanceRequirements || []).map(str).filter(Boolean),
    buyerManualRef: str(p.buyerManualRef) || null,
    routingGuideRef: str(p.routingGuideRef) || null,
  };
  const any = Object.values(value).some((v) => (Array.isArray(v) ? v.length : v));
  return resolve({
    key: "compliance",
    label: "Compliance and certifications",
    candidates: [
      any && candidate({
        status: STATUS.DRAFT,
        authority: AUTHORITY.BUYER_DEFAULT,
        value,
        source: source({ kind: "crm_account", ref: account.accountId }),
        note: "The buyer's standing requirements. No order-level compliance record exists to confirm them for this order.",
      }),
    ],
    /* Deliberately "missing", not "not applicable": an empty profile means
       nobody recorded requirements, which is not the same as the buyer
       having none. */
    missingNote: "No compliance requirements are recorded on the buyer's account.",
  });
}

function shippingFact(enquiry, account) {
  const f = enquiry?.freight || {};
  const fromEnquiry = {
    arrangement: str(f.arrangement) || null,
    mode: str(f.mode) || null,
    deliveryCount: num(f.deliveryCount),
    notes: str(f.notes) || null,
  };
  const p = account?.garmentSalesProfile || {};
  const defaults = {
    freightArrangement: str(account?.freightArrangement) || null,
    incoterm: str(account?.defaultIncoterm) || null,
    preferredFreightMode: str(p.preferredFreightMode) || null,
    deliveryCountry: str(p.defaultDeliveryCountry) || null,
  };
  return resolve({
    key: "shipping",
    label: "Freight and shipping",
    candidates: [
      Object.values(fromEnquiry).some((v) => v !== null) && candidate({
        status: STATUS.DRAFT,
        authority: AUTHORITY.ENQUIRY,
        value: fromEnquiry,
        source: source({ kind: "enquiry", ref: enquiry.enquiryId }),
        note: "Freight terms captured on the enquiry; not confirmed by any later record.",
      }),
      Object.values(defaults).some(Boolean) && candidate({
        status: STATUS.DRAFT,
        authority: AUTHORITY.BUYER_DEFAULT,
        value: defaults,
        source: source({ kind: "crm_account", ref: account.accountId }),
        note: "The buyer's standing freight defaults.",
      }),
    ],
    missingNote: "No freight or shipping terms are recorded.",
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
 * THE WHOLE BRIEF
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * @param {object} src
 * @param {object} src.request            the CustomerRequest (lean)
 * @param {object} [src.enquiry]          its enquiry, proved to be this order's
 * @param {object} [src.journey]          that enquiry's journey
 * @param {object} [src.account]          the buyer's CRM account
 * @param {Map}    [src.stylesById]       SampleStyle by String(_id)
 * @param {Array}  [src.handoverVersions] every SalesHandoverVersion of this order
 * @param {Array}  [src.executionFiles]   the Merchandising files for its lines
 * @param {Array}  [src.trimRevisions]    material/trim revisions of those files
 * @param {Array}  [src.packagingRevisions]
 * @param {object} [src.link]             how the enquiry was reached {basis, note}
 * @param {object} [src.ownership]        how ownership was proved {basis}
 * @param {Function} src.techApprovedOf   technicalRecord.approvedRevisionOf
 * @param {Date}   [src.now]
 */
function assembleOrderBrief(src) {
  const request = src.request;
  if (!request) throw new Error("assembleOrderBrief needs a request");
  if (typeof src.techApprovedOf !== "function") throw new Error("assembleOrderBrief needs techApprovedOf");

  const basis = quotationBasis(request);
  const ctx = {
    request,
    requestRef: request.requestId || String(request._id),
    basis,
    versions: src.handoverVersions || [],
    files: src.executionFiles || [],
    stylesById: src.stylesById || new Map(),
    trimRevisions: src.trimRevisions || [],
    packagingRevisions: src.packagingRevisions || [],
    enquiry: src.enquiry || null,
    account: src.account || null,
    techApprovedOf: src.techApprovedOf,
  };

  const order = {
    purchaseOrder: purchaseOrderFact(basis, src.journey || null),
    acceptedQuotation: acceptedQuotationFact(basis),
    acceptedTotal: acceptedTotalFact(basis),
    compliance: complianceFact(src.account || null),
    shipping: shippingFact(src.enquiry || null, src.account || null),
  };

  const lines = (request.items || []).map((item, index) => buildLine({ item, index, ctx }));

  const everyFact = [
    ...Object.values(order).map((fact) => ({ scope: "order", fact })),
    ...lines.flatMap((l) => Object.values(l.facts).map((fact) => ({ scope: l.lineRef || `index:${l.index}`, fact }))),
  ];

  const staleLines = lines.filter((l) => l.handover.stale);
  const divergedLines = lines.filter((l) => l.handover.divergences.length > 0);

  return {
    request: {
      id: String(request._id),
      requestId: str(request.requestId) || null,
      status: request.status || null,
      buyerName: str(src.account?.companyName) || str(request.customerInfo?.name) || null,
      createdAt: iso(request.createdAt),
    },
    ownership: src.ownership || null,
    link: src.link || null,
    order,
    lines,
    handover: {
      /* The headline: is any line's handover out of date? */
      anyStale: staleLines.length > 0,
      staleLines: staleLines.map((l) => ({ lineRef: l.lineRef, reasons: l.handover.staleReasons })),
      anyDiverged: divergedLines.length > 0,
      divergedLines: divergedLines.map((l) => ({ lineRef: l.lineRef, divergences: l.handover.divergences })),
      linesWithoutLineRef: lines.filter((l) => !l.lineRef).length,
    },
    summary: tally(everyFact.map((e) => e.fact)),
    fingerprint: fingerprintOf(everyFact),
    readAt: iso(src.now || new Date()),
    /* Said in the payload so no client can present this as a stored document. */
    kind: "read_model",
  };
}

module.exports = {
  assembleOrderBrief,
  contentEvidence,
  quotationBasis,
  staleReasons,
  handoverFor,
  quotationLineFor,
  ACCEPTED_QUOTATION,
  HANDOVER_STATE,
  STALE,
};

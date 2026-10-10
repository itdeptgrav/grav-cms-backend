"use strict";
// services/storePurchase/customerSuppliedRouting.service.js
//
// WHAT HAPPENS TO A LINE THE CUSTOMER IS SENDING.
//
// ── THE ROUTE NOBODY SHOULD HAVE TO CHOOSE ──────────────────────────────────
// A requester asks for twelve metres of fabric for a development sample and says
// one thing about it: the customer is sending it. They are not asked whether it
// should become usable inventory, which purchase-order type to raise, whether a
// goods receipt is required, or how the stock should be valued. Every one of
// those is a CONSEQUENCE of the answer, and a system that asks them is asking a
// merchandiser to do accounting.
//
// So approval infers the route. A customer-supplied line produces a customer
// material expectation and nothing else: no stock is held for it, no spend
// request is raised, and no purchase order can ever exist — not even a
// zero-value one. Nothing was bought, nobody is owed money, and a PO with a
// price of nought is read by somebody as free goods from a supplier.
//
// ── THE MRF IS THE DEMAND, NOT THE OWNER ────────────────────────────────────
// It says who asked, for what work, and how much. It does NOT say whose goods
// these are. Ownership is resolved on the server by walking the work context —
// a development's Sales journey, or an order's handover chain — because a client
// that could name the customer could attribute one customer's fabric to another
// by editing a form, and the lot on the shelf would carry it for ever.
//
// A broken chain refuses. An expectation whose owner cannot be proven is the one
// record in this design that must not exist.
//
// ── AND IT IS SAFE TO RETRY ─────────────────────────────────────────────────
// Approvals are delivered more than once, and a caller whose request timed out
// will send it again. Idempotency is the unique partial index on
// (companyId, sourceMrfLineId): a second attempt re-inserts the same pair and the
// database refuses it, rather than a read-then-write that two simultaneous
// retries would both pass.

const mongoose = require("mongoose");

const MRF = require("../../models/CMS_Models/Inventory/Operations/MRF");
const {
  ORIGIN, STATE, CustomerMaterialExpectation,
} = require("../../models/CMS_Models/Merchandising/CustomerMaterialExpectation");
const customerIdentity = require("../merchandising/customerIdentity.service");
/* Merchandising's own numberer and line-ref minter — see the note on its
   exports. One series, so a document's reference does not encode which path
   created it. */
const merchandisingCustomerMaterial = require("../merchandising/customerMaterial.service");

const str = (v) => String(v ?? "").trim();
const isId = (v) => mongoose.Types.ObjectId.isValid(str(v));
const r4 = (n) => Math.round((Number(n) || 0) * 10000) / 10000;

/* The same predicate the rest of the store uses for "approved and with the
   store", re-expressed here because this service is also called from cowork and
   intake, which do not import the store's MRF router. Kept identical
   deliberately — two definitions of "approved" is one too many. */
const isStoreActionable = (mrf) =>
  Boolean(mrf && (mrf.tlApproved || mrf.autoForwarded || mrf.creationMode === "BYPASS" || mrf.pmApproved));
const isApprovedRequest = (mrf) =>
  Boolean(mrf && ["APPROVED", "PARTIALLY_ISSUED"].includes(str(mrf.status)) && isStoreActionable(mrf));

const SUPPLY = Object.freeze({
  COMPANY: "COMPANY_FULFILLED",
  CUSTOMER: "CUSTOMER_SUPPLIED",
});

/* Why a line produced no expectation. Each is a different thing to do about it,
   so each is its own reason rather than one "skipped". */
const OUTCOME = Object.freeze({
  EXPECTED: "EXPECTED",            // an expectation now exists for this line
  ALREADY_EXPECTED: "ALREADY_EXPECTED", // it already did — a retry
  NOT_CUSTOMER_SUPPLIED: "NOT_CUSTOMER_SUPPLIED",
  NO_WORK_CONTEXT: "NO_WORK_CONTEXT",
  OWNER_UNPROVEN: "OWNER_UNPROVEN",
  LINE_CLOSED: "LINE_CLOSED",
  INVALID_QUANTITY: "INVALID_QUANTITY",
  FAILED: "FAILED",
});

/** Whether a line is one the customer is sending. Absence is company-fulfilled. */
const isCustomerSupplied = (line) => str(line?.supplySource) === SUPPLY.CUSTOMER;

/**
 * Whether automatic reservation should leave this line alone.
 *
 * Exported so the reservation service asks ONE question rather than growing its
 * own idea of what customer-supplied means. Holding company stock against a line
 * the customer is sending would reserve material for a need that is not the
 * company's to meet — and the stock it held would be unavailable to the work
 * that actually needs it.
 */
const reservationShouldSkip = (line) => isCustomerSupplied(line);

/**
 * Resolve whose goods a request's customer-supplied lines will be.
 *
 * Walks the work context, never the payload — see the header. Returns the
 * refusal verbatim so the caller can put the fix on screen rather than
 * translating a reason code into a guess.
 */
async function resolveOwner(ctx, mrf, session = null) {
  if (isId(mrf.developmentFileId)) {
    const identity = await customerIdentity.resolveFromDevelopmentId(ctx, mrf.developmentFileId, session);
    return { ...identity, origin: ORIGIN.DEVELOPMENT_SAMPLE };
  }
  if (isId(mrf.executionFileId)) {
    const identity = await customerIdentity.resolveFromFileId(ctx, mrf.executionFileId, session);
    return { ...identity, origin: ORIGIN.CONFIRMED_ORDER };
  }
  return {
    ok: false,
    reason: "NO_WORK_CONTEXT",
    message:
      "This request does not say which development or order the material is for, so the customer "
      + "sending it cannot be established. Raise it from the development, or attach the order.",
  };
}

/**
 * Route one approved request's customer-supplied lines into expectations.
 *
 * @returns {Promise<{routed:boolean, lines:Array, reason?:string}>}
 *
 * RESOLVES on every path. An approval that has already been committed must not
 * be undone because an expectation could not be composed — the request stands,
 * the line reports why, and the store can fix the lineage and route it again.
 */
async function routeApprovedRequest({ tenant, mrfId, actor = null }) {
  const out = { routed: false, lines: [] };
  try {
    if (!tenant?.companyId || !isId(mrfId)) return { ...out, reason: "NO_CONTEXT" };

    const mrf = await MRF.findOne({ _id: mrfId });
    if (!mrf) return { ...out, reason: "NOT_FOUND" };
    /* `MRF.companyId` is optional and genuinely absent on requests raised through
       the Requests desk, so ownership is tested rather than filtered — the same
       rule automatic reservation uses. */
    if (mrf.companyId && str(mrf.companyId) !== str(tenant.companyId)) {
      return { ...out, reason: "TENANT_MISMATCH" };
    }

    /* ── ONLY A REQUEST THAT IS ACTUALLY APPROVED ─────────────────────────
       The approved MRF IS the authorization to expect the material — which is
       precisely why the approval has to have happened. Routing a request still
       with its TL would state a delivery to Store on the strength of a decision
       nobody has taken, and the expectation is ISSUED the moment it exists, so
       there is no draft stage in which somebody would notice.

       `PARTIALLY_ISSUED` counts: it is an approved request part-way through
       being fulfilled, not a different decision. The predicate is the same one
       the rest of the store uses for "is this with the store". */
    if (!isApprovedRequest(mrf)) {
      return { ...out, reason: "NOT_APPROVED" };
    }

    const customerLines = (mrf.items || []).filter(isCustomerSupplied);
    if (customerLines.length === 0) return { ...out, routed: true };

    /* Resolved ONCE for the request: every line of it is for the same piece of
       work and therefore the same customer. Resolving per line would allow two
       lines of one request to end up owned by different people. */
    const owner = await resolveOwner(tenant, mrf);
    if (!owner.ok) {
      for (const line of customerLines) {
        out.lines.push({
          mrfLineId: str(line._id),
          itemName: str(line.rawItemName),
          outcome: owner.reason === "NO_WORK_CONTEXT" ? OUTCOME.NO_WORK_CONTEXT : OUTCOME.OWNER_UNPROVEN,
          reason: owner.reason,
          message: owner.message,
        });
      }
      out.routed = true;
      return out;
    }

    for (const line of customerLines) {
      out.lines.push(await routeLine({ tenant, mrf, line, owner, actor }));
    }
    out.routed = true;
    return out;
  } catch (e) {
    return { ...out, reason: "FAILED", error: e?.message || String(e) };
  }
}

/** One line. Never throws; the outcome is the answer. */
async function routeLine({ tenant, mrf, line, owner, actor }) {
  const base = { mrfLineId: str(line._id), itemName: str(line.rawItemName) };

  if (["REJECTED", "UNFULFILLED"].includes(str(line.itemStatus))) {
    return { ...base, outcome: OUTCOME.LINE_CLOSED, message: "This line is closed." };
  }
  /* Its request reached the Store because a sibling line was approved; this
     one is still with the manager. Its approval routes it then. */
  if (line.approval && line.approval.decision === "PENDING") {
    return { ...base, outcome: OUTCOME.LINE_CLOSED, message: "This line is still waiting for the manager's approval." };
  }
  const quantity = Number(line.requestedQty);
  /* `Number(null)` and `Number("")` are both 0 and both finite, so a blank
     quantity would otherwise read as a deliberate zero. */
  if (!Number.isFinite(quantity) || quantity <= 0 || !str(line.unit)) {
    return {
      ...base,
      outcome: OUTCOME.INVALID_QUANTITY,
      message: "This line has no usable quantity or unit, so nothing can be expected against it.",
    };
  }

  /* ── THE RETRY ANSWERS ITSELF ──────────────────────────────────────────
     Read first for the ordinary repeat, and the unique index below catches the
     two that arrive at the same moment. */
  const existing = await CustomerMaterialExpectation
    .findOne({ companyId: tenant.companyId, sourceMrfLineId: line._id })
    .sort({ revisionNo: -1 }).lean();
  if (existing) {
    return {
      ...base,
      outcome: OUTCOME.ALREADY_EXPECTED,
      expectationId: str(existing._id),
      documentRef: str(existing.documentRef),
      message: "This line is already expected — the same document is returned.",
    };
  }

  try {
    const documentRef = await merchandisingCustomerMaterial.nextDocumentRef();
    const doc = await CustomerMaterialExpectation.create({
      companyId: tenant.companyId,
      siteId: tenant.siteId || null,
      origin: owner.origin,
      ...(owner.origin === ORIGIN.DEVELOPMENT_SAMPLE
        ? { developmentFileId: mrf.developmentFileId }
        : { executionFileId: mrf.executionFileId }),

      /* Ownership, from the server's own walk. */
      customerId: owner.customerId,
      customerRequestId: owner.customerRequestId || null,
      customerSnapshot: owner.snapshot,

      /* What this is for, as the development stated it. */
      productName: str(owner.development?.productName),
      styleRef: str(owner.development?.styleRef),
      buyerDisplayLabel: str(owner.development?.buyerDisplayLabel),

      /* The demand, for audit — never for ownership. */
      sourceMrfId: mrf._id,
      sourceMrfNumber: str(mrf.mrfNumber),
      sourceMrfLineId: line._id,

      documentRef,
      revisionNo: 1,
      /* ── ISSUED, NOT DRAFT ───────────────────────────────────────────────
         A draft is a document somebody is still composing, and Store cannot
         receive against one. This document was not composed by a merchandiser
         weighing options: it is the direct consequence of an approval that has
         already happened, and the quantity on it is the quantity that was
         approved. Leaving it as a draft would mean the approval decided
         nothing until somebody re-confirmed it by hand. */
      state: STATE.ISSUED,
      issuedAt: new Date(),
      issuedBy: actor || undefined,
      createdBy: actor || undefined,

      lines: [{
        lineRef: merchandisingCustomerMaterial.newLineRef(),
        rawItemId: line.rawItem || null,
        variantId: line.variantId || null,
        rawItemName: str(line.rawItemName),
        rawItemSku: str(line.rawItemSku),
        variantCombination: (line.variantCombination || []).map(str),
        requiredQuantity: r4(quantity),
        unit: str(line.unit),
        expectedArrivalDate: mrf.neededBy || null,
        note: "",
        addedAt: new Date(),
      }],
    });

    return {
      ...base,
      outcome: OUTCOME.EXPECTED,
      expectationId: str(doc._id),
      documentRef: str(doc.documentRef),
      origin: owner.origin,
      message: "A customer-material expectation was created and sent to Store.",
    };
  } catch (e) {
    /* A duplicate key means another attempt at the same line got there first.
       Its document is the answer; this one creates nothing. */
    if (e?.code === 11000) {
      const settled = await CustomerMaterialExpectation
        .findOne({ companyId: tenant.companyId, sourceMrfLineId: line._id }).lean();
      if (settled) {
        return {
          ...base,
          outcome: OUTCOME.ALREADY_EXPECTED,
          expectationId: str(settled._id),
          documentRef: str(settled.documentRef),
          message: "This line is already expected — the same document is returned.",
        };
      }
    }
    return {
      ...base,
      outcome: OUTCOME.FAILED,
      message: `The expectation could not be created: ${e?.message || "unknown error"}. The approval stands.`,
    };
  }
}

/* ── WHEN THE REQUEST IS WITHDRAWN ───────────────────────────────────────────
 *
 * The expectation exists because the request authorised it. Withdraw the
 * request and the authorisation is gone, so Store must stop planning around a
 * delivery nobody is sending — leaving it ISSUED would have a storekeeper
 * holding space and chasing a customer for material no longer wanted.
 *
 * ── EXCEPT THAT CANCELLING DOES NOT UNSHIP A LORRY ──────────────────────────
 * If any of it has already arrived, the goods are on the shelf, they belong to
 * the customer, and they are already in lots that QC and issue read. Cancelling
 * the document they were received against would strand that stock against a
 * withdrawn expectation — a quantity nobody can reconcile and nobody may return.
 *
 * So a partly-received expectation is REFUSED, loudly, and the refusal names the
 * operational resolution: short-close the remaining lines so no more is
 * expected, and send back or consume what already came through the paths that
 * exist for it. Those are decisions with physical consequences, and a request
 * being withdrawn is not authority to take them.
 */
const CANCELLATION = Object.freeze({
  CANCELLED: "CANCELLED",
  REFUSED_RECEIPTS_EXIST: "REFUSED_RECEIPTS_EXIST",
  ALREADY_CANCELLED: "ALREADY_CANCELLED",
  NONE: "NONE",
  FAILED: "FAILED",
});

/**
 * Withdraw the expectations an MRF authorised, where that is safe.
 *
 * @returns {Promise<{handled:boolean, expectations:Array}>} resolves always —
 *          a cancellation that cannot be completed is a state to show, not an
 *          error that undoes the withdrawal of the request.
 */
async function cancelForRequest({ tenant, mrfId, reason = "", actor = null }) {
  const out = { handled: false, expectations: [] };
  try {
    if (!tenant?.companyId || !isId(mrfId)) return { ...out, reason: "NO_CONTEXT" };

    const docs = await CustomerMaterialExpectation
      .find({ companyId: tenant.companyId, sourceMrfId: mrfId })
      .select("_id documentRef state revision").lean();
    if (docs.length === 0) return { ...out, handled: true };

    /* Required lazily: the receipt service pulls the lot and movement graph,
       and a top-level require would load it for every approval. */
    const receipts = require("./customerMaterialReceipt.service");
    const merchandising = require("../merchandising/customerMaterial.service");

    for (const row of docs) {
      const entry = { expectationId: str(row._id), documentRef: str(row.documentRef) };

      if (str(row.state) === "CANCELLED") {
        out.expectations.push({ ...entry, outcome: CANCELLATION.ALREADY_CANCELLED });
        continue;
      }

      /* Has any of it arrived? Asked of the receipt service, which owns the
         answer, rather than counted here from lots — a second way of deciding
         "has anything been received" is a second answer waiting to disagree. */
      let received = 0;
      try {
        const standing = await receipts.standingFor(tenant, row);
        received = (standing?.lines || []).reduce((t, l) => t + (Number(l.receivedQuantity) || 0), 0);
      } catch {
        /* If it cannot be established that nothing has arrived, nothing is
           cancelled. The safe direction is always to leave the document alone. */
        out.expectations.push({
          ...entry,
          outcome: CANCELLATION.REFUSED_RECEIPTS_EXIST,
          message: "Whether anything has already been received could not be read, so this expectation "
            + "was left as it is. Check it in Store before withdrawing it.",
        });
        continue;
      }

      if (received > 0) {
        out.expectations.push({
          ...entry,
          outcome: CANCELLATION.REFUSED_RECEIPTS_EXIST,
          receivedQuantity: received,
          message: "Material has already been received against this expectation, so it was not "
            + "withdrawn — cancelling it would strand customer-owned stock against a withdrawn "
            + "document. Short-close the remaining lines so no more is expected, and return or "
            + "consume what has arrived through its own path.",
        });
        continue;
      }

      try {
        /* Merchandising's OWN cancellation, so the audit trail, the revision
           counter and the withdrawal reason are the ones every other reader of
           this document already understands. */
        await merchandising.cancel(tenant, {
          docId: row._id,
          body: {
            reason: reason || "The material request behind this was withdrawn.",
            /* Merchandising's own optimistic-concurrency check, honoured rather
               than bypassed: it is what stops two people cancelling over each
               other, and a caller that skipped it would be the one case where
               that protection did not apply. A document somebody edited between
               the read above and here refuses, and the refusal is reported. */
            expectedRevision: row.revision ?? 0,
          },
          actor,
        });
        out.expectations.push({ ...entry, outcome: CANCELLATION.CANCELLED });
      } catch (e) {
        out.expectations.push({
          ...entry, outcome: CANCELLATION.FAILED, message: e?.message || String(e),
        });
      }
    }

    out.handled = true;
    return out;
  } catch (e) {
    return { ...out, reason: "FAILED", error: e?.message || String(e) };
  }
}

/** Fire-and-forget, for the approval routes. The approval has already committed. */
function routeInBackground(opts) {
  return Promise.resolve()
    .then(() => routeApprovedRequest(opts))
    .catch((e) => { console.error("[customerSuppliedRouting]", e?.message || e); return null; });
}

module.exports = {
  SUPPLY, OUTCOME,
  CANCELLATION,
  isCustomerSupplied, reservationShouldSkip, resolveOwner, isApprovedRequest,
  cancelForRequest,
  routeApprovedRequest, routeInBackground,
};

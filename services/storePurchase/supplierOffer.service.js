"use strict";
/**
 * services/storePurchase/supplierOffer.service.js
 *
 * Store & Purchase — THE RULES A SUPPLIER OFFER MUST OBEY.
 *
 * ── WHERE THE FACTS COME FROM ───────────────────────────────────────────────
 * Supplier, item, variant and unit are read through `storeFacts.service.js`.
 * It lives under `centralCosting/` for historical reasons — Chunk 3A built it
 * — but it takes a domain-neutral `{companyId, reason}` service context and
 * belongs to nobody in particular. Reimplementing the same three lookups here
 * would be a second definition of "does this supplier belong to this company",
 * and the two would drift.
 *
 * ── AND WHAT IS DELIBERATELY NOT COMPUTED ───────────────────────────────────
 * No UoM conversion. `unitFacts` returns the declared factors; if the purchase
 * UoM cannot be reconciled with the item's base UoM this says
 * `conversion not configured` and stops. Inventing a factor would put a number
 * nobody declared into a price somebody quotes.
 */

const mongoose = require("mongoose");
const SupplierOffer = require("../../models/CMS_Models/Inventory/Sourcing/SupplierOffer");
const storeFacts = require("../centralCosting/storeFacts.service");
const { fail } = require("./errors");

const { PRICE_BASES, SUPPORTED_CURRENCIES } = SupplierOffer;

/* ── STABLE REFUSAL CODES ────────────────────────────────────────────────── */
const CODES = Object.freeze({
  NOT_FOUND: "NOT_FOUND",
  VALIDATION: "VALIDATION",
  CONFLICT: "CONFLICT",
  OFFER_NOT_ACTIVE: "SUPPLIER_OFFER_NOT_ACTIVE",
  OFFER_ALREADY_SUPERSEDED: "SUPPLIER_OFFER_ALREADY_SUPERSEDED",
  WITHDRAWAL_REASON_REQUIRED: "SUPPLIER_OFFER_WITHDRAWAL_REASON_REQUIRED",
  /* A revision that changed the product would splice a different thing into
     an existing quotation's history. */
  SUBJECT_MISMATCH: "SUPPLIER_OFFER_SUBJECT_MISMATCH",
});

/* ── THE ONE "NOT FOUND" ─────────────────────────────────────────────────────
 * Another company's supplier, another company's item, a malformed id and a
 * record that never existed are ONE answer. A refusal that varies with the
 * secret discloses the secret — a 403 for a foreign id confirms the id
 * exists, which is what the company boundary is for. */
const notFound = (what = "That supplier offer") =>
  fail(CODES.NOT_FOUND, `${what} was not found.`);

const invalid = (message, details) => fail(CODES.VALIDATION, message, details);

const present = (v) => v !== null && v !== undefined && v !== "";
const oid = (v) => (mongoose.Types.ObjectId.isValid(String(v || "")) ? String(v) : null);

/* ── MONEY IN, AS AN INTEGER OR NOT AT ALL ───────────────────────────────────
 * The client sends minor units. A decimal, a string with a point in it, or
 * anything beyond the safe-integer range is refused rather than rounded —
 * rounding here is a price nobody quoted, arrived at silently. */
function requireMinor(value, field) {
  if (!present(value)) throw invalid(`${field} is required.`, { field });
  const n = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isSafeInteger(n) || n < 0) {
    throw invalid(
      `${field} must be a whole number of minor units — 12.30 is sent as 1230.`,
      { field, received: value },
    );
  }
  return n;
}

/**
 * A whole number of days, zero included, or nothing.
 *
 * ── ZERO IS A LEAD TIME ─────────────────────────────────────────────────────
 * `optionalPositive` refused it, so a supplier who delivers the same day could
 * not be recorded as doing so — the only way through was to leave the field
 * blank, which the register then reads as "not recorded". Three different
 * facts were being flattened into two, and the one that was lost was the good
 * news. The model always allowed it; the parser did not.
 *
 * Blank stays absent. `0` is same-day. Negative and fractional are refused —
 * half a day of lead time is not a thing this field can express.
 */
const optionalDays = (value, field) => {
  if (!present(value)) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw invalid(`${field} is a whole number of days — 0 for same day.`, { field, received: value });
  }
  return n;
};

const optionalPositive = (value, field, { integer = false } = {}) => {
  if (!present(value)) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || (integer && !Number.isInteger(n))) {
    throw invalid(`${field} must be a positive ${integer ? "whole number" : "quantity"}.`, { field, received: value });
  }
  return n;
};

/* ── TIERS ARE ORDERED, DISJOINT AND REAL ────────────────────────────────────
 * A tier list that overlaps has two prices for one quantity, and whichever the
 * reader picks is a coin toss recorded as a quotation. Sorted and checked
 * rather than trusted, because a client that sends them out of order is not
 * malicious — it is a form somebody filled in from a fax.
 *
 * ── AND A CEILING IS A REAL TERM, NOT A TIDINESS PROBLEM ────────────────────
 * `maxQuantity` is optional. Where a supplier stated one it is kept, and a
 * quantity beyond it — or in a gap between two tiers — has no quoted price at
 * all. That case is refused at resolution rather than falling back to the
 * nearest tier, which would quote a rate nobody offered.
 *
 * An open-ended tier (no max) is still allowed, because plenty of quotations
 * genuinely are open-ended. Only one may be, and it must be the last: two
 * open-ended tiers overlap by definition. */
function normaliseTiers(raw) {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) throw invalid("Quantity tiers must be a list.", { field: "tiers" });
  if (!raw.length) return undefined;

  const tiers = raw.map((t, i) => {
    const minQuantity = Number(t?.minQuantity);
    if (!Number.isFinite(minQuantity) || minQuantity <= 0) {
      throw invalid(`Tier ${i + 1} must start at a positive quantity.`, { field: `tiers[${i}].minQuantity` });
    }
    let maxQuantity;
    if (present(t?.maxQuantity)) {
      maxQuantity = Number(t.maxQuantity);
      if (!Number.isFinite(maxQuantity) || maxQuantity <= 0) {
        throw invalid(`Tier ${i + 1} ends at a positive quantity.`, { field: `tiers[${i}].maxQuantity` });
      }
      if (maxQuantity < minQuantity) {
        throw invalid(
          `Tier ${i + 1} ends at ${maxQuantity}, below the ${minQuantity} it starts at.`,
          { field: `tiers[${i}].maxQuantity`, minQuantity, maxQuantity },
        );
      }
    }
    return {
      minQuantity,
      ...(maxQuantity === undefined ? {} : { maxQuantity }),
      unitPriceMinor: requireMinor(t?.unitPriceMinor, `tiers[${i}].unitPriceMinor`),
      ...(present(t?.note) ? { note: String(t.note).trim().slice(0, 300) } : {}),
    };
  }).sort((a, b) => a.minQuantity - b.minQuantity);

  for (let i = 1; i < tiers.length; i += 1) {
    const prev = tiers[i - 1];
    const cur = tiers[i];
    /* Equal is an overlap too — two prices from the same quantity is the
       ambiguity this check exists to prevent, not a boundary case. */
    if (cur.minQuantity <= prev.minQuantity) {
      throw invalid(
        `Tiers must start at increasing quantities — ${cur.minQuantity} appears twice or out of order.`,
        { field: "tiers", at: cur.minQuantity },
      );
    }
    /* ── AN UNBOUNDED TIER RUNS UNTIL THE NEXT ONE STARTS ─────────────────
       Which is the established reading of a tier list and is left alone: a
       quotation written "100+ at ₹410, 500+ at ₹390" is an ordinary one and
       stating a ceiling on the first band would be inventing a term. Only an
       EXPLICIT ceiling that reaches into the next band is a contradiction —
       two prices the supplier stated for one quantity. */
    if (prev.maxQuantity !== undefined && cur.minQuantity <= prev.maxQuantity) {
      throw invalid(
        `Tiers overlap: ${prev.minQuantity}–${prev.maxQuantity} and ${cur.minQuantity} both cover ${cur.minQuantity}.`,
        { field: "tiers", at: cur.minQuantity },
      );
    }
  }
  return tiers;
}

/**
 * The tier covering `quantity`, in the offer's PURCHASE UoM.
 *
 * ── THE THREE ANSWERS, KEPT APART ───────────────────────────────────────────
 *   • a tier covers it            → that tier's price;
 *   • no tiers were quoted at all → the offer's own base price;
 *   • tiers were quoted and none  → NOTHING. Not the base price, not the
 *     nearest tier.
 *
 * The third is the one worth being careful about. A supplier who quoted bands
 * from 500 upward has said nothing about 100, and a supplier whose top band
 * ends at 999 has said nothing about 5,000. Falling back to the base price
 * there would put a rate into a costing that nobody offered for that quantity
 * — and freeze it as evidence.
 *
 * Returns `{covered: false}` rather than throwing: the applicability resolver
 * turns that into a named exclusion beside every other reason.
 */
function tierCovering(offer, quantity) {
  const tiers = Array.isArray(offer?.tiers) ? offer.tiers : [];
  const q = Number(quantity);
  if (!tiers.length) {
    return { covered: true, source: "BASE", unitPriceMinor: offer.unitPriceMinor, minQuantity: null, maxQuantity: null };
  }
  if (!Number.isFinite(q)) return { covered: false, source: null };
  for (let i = 0; i < tiers.length; i += 1) {
    const t = tiers[i];
    const min = Number(t.minQuantity);
    /* Explicit ceiling where the supplier stated one; otherwise the band runs
       until the next band starts, and the last unbounded band runs on. */
    const stated = present(t.maxQuantity) ? Number(t.maxQuantity) : null;
    const next = tiers[i + 1] ? Number(tiers[i + 1].minQuantity) : null;
    const covers = q >= min
      && (stated !== null ? q <= stated : (next === null || q < next));
    if (covers) {
      return {
        covered: true, source: "TIER", unitPriceMinor: t.unitPriceMinor,
        minQuantity: min, maxQuantity: stated, note: t.note || null,
      };
    }
  }
  /* Below the first band, or past a stated ceiling with nothing after it, or
     inside a gap two stated ceilings leave open. */
  return { covered: false, source: null, belowFirstTier: q < Number(tiers[0].minQuantity) };
}

/* ══ DERIVED FIGURES ═════════════════════════════════════════════════════════
 *
 * Computed on the SERVER and returned, so the desktop table and the phone
 * cards render one answer rather than two implementations of the same
 * arithmetic. Nothing about tax is recomputed on the client.
 *
 * ── AND NOT COMPUTED AT ALL WHERE THE RATE IS UNKNOWN ───────────────────────
 * With no GST rate recorded there is no net and no gross — only the quoted
 * figure and its basis. Returning the quoted number in all three slots would
 * state a tax position nobody recorded.
 */
function priceFigures(offer) {
  const quoted = offer.unitPriceMinor;
  const rate = offer.gstRatePercent;
  const basis = offer.priceBasis;

  /* ── A STATED NIL IS AN ANSWER, NOT A MISSING ONE ───────────────────────
     NON_TAXABLE is the supplier saying this supply carries no GST. The net,
     the gross and the quoted figure are then all the same number and the tax
     is a recorded zero — which is exactly what an UNRECORDED rate is not. */
  if (basis === "NON_TAXABLE") {
    return {
      quotedMinor: quoted, basis, gstKnown: true,
      netUnitPriceMinor: quoted,
      gstAmountMinor: 0,
      grossUnitPriceMinor: quoted,
      reason: null,
    };
  }

  if (!present(rate)) {
    return {
      quotedMinor: quoted,
      basis,
      gstKnown: false,
      /* Absent, not zero. */
      netUnitPriceMinor: basis === "TAX_EXCLUSIVE" ? quoted : null,
      gstAmountMinor: null,
      grossUnitPriceMinor: basis === "TAX_INCLUSIVE" ? quoted : null,
      reason: "GST_RATE_NOT_RECORDED",
    };
  }

  /* Integer arithmetic throughout, rounded once at the end — a float here
     would put a fraction of a paisa into a register of exact prices. */
  const pct = Number(rate);
  if (basis === "TAX_EXCLUSIVE") {
    const gst = Math.round((quoted * pct) / 100);
    return {
      quotedMinor: quoted, basis, gstKnown: true,
      netUnitPriceMinor: quoted,
      gstAmountMinor: gst,
      grossUnitPriceMinor: quoted + gst,
      reason: null,
    };
  }
  /* Inclusive: the net is the quoted figure less the tax already inside it. */
  const net = Math.round((quoted * 100) / (100 + pct));
  return {
    quotedMinor: quoted, basis, gstKnown: true,
    netUnitPriceMinor: net,
    gstAmountMinor: quoted - net,
    grossUnitPriceMinor: quoted,
    reason: null,
  };
}

/* ══ DERIVED STATE ═══════════════════════════════════════════════════════════
 *
 * Six answers, and they are six different facts. Collapsing "expired" into
 * "withdrawn" would blame somebody for the calendar; collapsing "future" into
 * "current" would quote a price that has not started.
 *
 * Expiry is derived rather than stored — a record does not change because a
 * date passed, and a stored flag would need a job to age it and would be
 * wrong between runs. The clock is a parameter so the derivation is testable
 * at a fixed instant rather than at whenever the suite happens to run.
 */
const STATES = Object.freeze({
  CURRENT: "current",
  FUTURE: "future",
  EXPIRED: "expired",
  WITHDRAWN: "withdrawn",
  SUPERSEDED: "superseded",
  INCOMPLETE: "incomplete",
});

function deriveState(offer, now = new Date()) {
  if (offer.status === "WITHDRAWN") return STATES.WITHDRAWN;
  if (offer.status === "SUPERSEDED") return STATES.SUPERSEDED;
  /* A draft is not a commercial answer yet — and calling it "current" is how
     an unfinished entry gets quoted. */
  if (offer.status === "DRAFT") return STATES.INCOMPLETE;

  const from = offer.effectiveFrom ? new Date(offer.effectiveFrom) : null;
  if (from && from.getTime() > now.getTime()) return STATES.FUTURE;
  const until = offer.validUntil ? new Date(offer.validUntil) : null;
  if (until && until.getTime() < now.getTime()) return STATES.EXPIRED;
  return STATES.CURRENT;
}

/** May this offer be treated as a live price? One place, one answer. */
const isSelectable = (offer, now = new Date()) => deriveState(offer, now) === STATES.CURRENT;

/* ══ THE STORE FACTS, CHECKED TOGETHER ═══════════════════════════════════════
 *
 * Supplier, item, variant and unit — all in this company, all active, and the
 * variant belonging to the item that was named. Every failure is the same
 * `NOT_FOUND`, because "that supplier is not yours" and "that supplier does
 * not exist" must not be distinguishable.
 */
async function resolveSubject(ctx, { supplierId, itemId, variantId, purchaseUom }) {
  const supplier = await storeFacts.supplierIdentity(ctx, supplierId);
  if (!supplier) throw notFound("That supplier");
  /* An inactive supplier may appear on history and may not be quoted from. */
  if (supplier.status && String(supplier.status).toLowerCase() !== "active") {
    throw invalid(`${supplier.name || "That supplier"} is not active, so a new offer cannot be recorded against them.`,
      { field: "supplierId", status: supplier.status });
  }

  const item = await storeFacts.itemFacts(ctx, itemId, { variantId: variantId || null });
  if (!item) throw notFound("That item");

  let variant = null;
  if (variantId) {
    variant = (item.variants || []).find((v) => String(v.variantId) === String(variantId)) || null;
    /* ── A VARIANT MUST BELONG TO THE ITEM ─────────────────────────────────
       `itemFacts` narrows by item first, so a variant id from another item
       simply is not here — and it is refused as not found rather than as a
       validation error, so the two cannot be told apart. */
    if (!variant) throw notFound("That variant");
  }

  /* The unit is optional as an ID — `RawItem.unit` is a bare string and many
     deployments have no Unit row for it. Where one is named, it must be this
     company's and it must be active. */
  let unit = null;
  const wanted = String(purchaseUom || "").trim();
  if (wanted) {
    unit = await storeFacts.unitFacts(ctx, wanted);
    if (unit && unit.status && String(unit.status).toLowerCase() !== "active") {
      throw invalid(`${unit.name} is not an active unit.`, { field: "purchaseUom", status: unit.status });
    }
  }

  return { supplier, item, variant, unit };
}

/**
 * Can the purchase UoM be reconciled with the item's base UoM?
 *
 * ── NOTHING IS INVENTED ─────────────────────────────────────────────────────
 * Same unit: trivially yes. A declared conversion: yes, and the factor is
 * reported. Anything else: `configured: false` with the two unit names, so the
 * screen can say "conversion not configured" instead of a screen showing a
 * price per metre against an item counted in kilograms as though they matched.
 */
function reconcileUom({ item, unit, purchaseUom }) {
  const base = String(item?.purchaseUom || "").trim();
  const bought = String(purchaseUom || "").trim();
  if (!base || !bought) {
    return { configured: false, reason: "UOM_NOT_RECORDED", baseUom: base || null, purchaseUom: bought || null };
  }
  if (base.toLowerCase() === bought.toLowerCase()) {
    return { configured: true, sameUnit: true, factor: 1, baseUom: base, purchaseUom: bought };
  }
  const hit = (unit?.conversions || []).find(
    (c) => String(c.toUnitName || "").toLowerCase() === base.toLowerCase(),
  );
  if (hit && Number.isFinite(Number(hit.factor)) && Number(hit.factor) > 0) {
    return { configured: true, sameUnit: false, factor: Number(hit.factor), baseUom: base, purchaseUom: bought };
  }
  return {
    configured: false,
    reason: "CONVERSION_NOT_CONFIGURED",
    baseUom: base, purchaseUom: bought,
  };
}

/* ══ THE READ SHAPE ══════════════════════════════════════════════════════════ */

function serialize(offer, { now = new Date(), uom = null } = {}) {
  const doc = offer?.toObject ? offer.toObject() : offer;
  if (!doc) return null;
  const state = deriveState(doc, now);
  return {
    id: String(doc._id),
    supplier: { id: String(doc.supplierId), name: doc.supplierName || "" },
    item: { id: String(doc.itemId), name: doc.itemName || "", sku: doc.itemSku || "" },
    variant: doc.variantId ? { id: String(doc.variantId), label: doc.variantLabel || "" } : null,
    supplierItemCode: doc.supplierItemCode || null,
    supplierItemName: doc.supplierItemName || null,
    purchaseUom: doc.purchaseUom,
    currency: doc.currency,
    /* Server-computed, so both layouts render one answer. */
    price: priceFigures(doc),
    /* Absent stays absent — the screen must not print 0% for an unrecorded
       rate, and it cannot if the field is null. */
    gstRatePercent: present(doc.gstRatePercent) ? doc.gstRatePercent : null,
    hsnCode: doc.hsnCode || null,
    /* ── WHERE THE GOODS COME FROM ────────────────────────────────────
       Published so Store's own screens can read back what they recorded.
       Absent stays absent: `null` is "nobody answered", which the register
       shows as "Not recorded" and a costing reports as unanswered — never as
       a domestic supply with no duty. */
    sourcing: doc.sourcing?.type
      ? {
        type: doc.sourcing.type,
        countryOfOrigin: doc.sourcing.countryOfOrigin || null,
        evidenceNote: doc.sourcing.evidenceNote || "",
      }
      : null,
    moq: present(doc.moq) ? doc.moq : null,
    orderMultiple: present(doc.orderMultiple) ? doc.orderMultiple : null,
    leadTimeDays: present(doc.leadTimeDays) ? doc.leadTimeDays : null,
    tiers: Array.isArray(doc.tiers) && doc.tiers.length
      ? doc.tiers.map((t) => ({
        minQuantity: t.minQuantity,
        /* Null is "open-ended", which the screen prints as a word rather than
           as a blank cell somebody reads as zero. */
        maxQuantity: present(t.maxQuantity) ? t.maxQuantity : null,
        unitPriceMinor: t.unitPriceMinor,
        note: t.note || null,
      }))
      : null,
    quotationReference: doc.quotationReference || null,
    quotationDate: doc.quotationDate || null,
    document: doc.document?.label || doc.document?.url
      ? { label: doc.document.label || "", url: doc.document.url || "", storedAt: doc.document.storedAt || "" }
      : null,
    effectiveFrom: doc.effectiveFrom || null,
    /* Null means "validity not recorded", which the screen says in words. */
    validUntil: doc.validUntil || null,
    notes: doc.notes || null,
    terms: doc.terms || null,

    status: doc.status,
    state,
    selectable: state === STATES.CURRENT,
    revision: doc.revision ?? 1,
    supersedesOfferId: doc.supersedesOfferId ? String(doc.supersedesOfferId) : null,
    supersededByOfferId: doc.supersededByOfferId ? String(doc.supersededByOfferId) : null,
    supersededAt: doc.supersededAt || null,
    withdrawnAt: doc.withdrawnAt || null,
    withdrawnByName: doc.withdrawnByName || null,
    withdrawalReason: doc.withdrawalReason || null,
    activatedAt: doc.activatedAt || null,
    createdByName: doc.createdByActorName || "",
    updatedByName: doc.updatedByActorName || "",
    createdAt: doc.createdAt || null,
    updatedAt: doc.updatedAt || null,
    /* Present only where it was worked out — a read of the register does not
       load every unit. */
    ...(uom ? { uomReconciliation: uom } : {}),
  };
}

module.exports = {
  CODES, STATES, PRICE_BASES, SUPPORTED_CURRENCIES,
  notFound, invalid, present, oid,
  requireMinor, optionalPositive, optionalDays, normaliseTiers,
  priceFigures, deriveState, isSelectable, resolveSubject, reconcileUom, serialize,
  tierCovering,
};

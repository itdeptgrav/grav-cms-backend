// services/centralCosting/quotationPricing.service.js
//
// THE SERVER SIDE OF "THIS PRICE CAME FROM AN APPROVED COSTING".
//
// ── WHAT WAS NOT TRUE ───────────────────────────────────────────────────────
// The quotation line schema said its `costingSource` was server-stamped. It was
// not. The save route spread `...item` and calculated from the submitted
// `unitPrice`, so a browser could post any figure alongside a `costingSource`
// naming a real approved version — and the saved quotation would then claim a
// costing had approved a number nobody costed. The comment described an
// intention; this file is where it becomes a fact.
//
// ── SO THE BROWSER SENDS AN INTENT, NOT A PRICE ─────────────────────────────
// Two fields: which style, and which of the three approved tiers. Everything
// else — the version, the scenario, the price, the currency, the fingerprint —
// is read here from the approved version. A client cannot express the idea
// "this costs ₹9", only "price this from the approved costing at target".
//
// ── AND IT IS THE SAME CHECK AT SAVE AND AT SEND ────────────────────────────
// Saving records what was true; sending shows it to a customer. Between the
// two a costing can be revised and re-approved, so the send paths re-verify
// rather than trusting the stamp. One module, so the two can never disagree
// about what "still current" means.

"use strict";

const mongoose = require("mongoose");

const approvedOutput = require("./approvedOutput.service");
const companyContext = require("./companyContext.service");
const { serviceFilter } = require("../companyContext/serviceScope.service");
/* The issuance authority — the same one that decided this proforma could be
   raised at all, and the same one that stamped the figures onto the request. */
const lineReadiness = require("../sales/lineReadiness.service");

/* ── ONE SCOPING AUTHORITY, NOT A HAND-WRITTEN CLAUSE ────────────────────
   The enquiry behind a style is read through the shared service scope, which
   is the same door every other service read of a Sales record goes through —
   and which requires a stated reason, so a scoped read is never anonymous. */


/* Every refusal is a different thing for Sales to do, so none is collapsed
   into a generic failure. */
const CODES = Object.freeze({
  NO_STYLE: "QUOTATION_LINE_NO_STYLE",
  NO_COSTING: "QUOTATION_LINE_NO_COSTING",
  NO_APPROVAL: "QUOTATION_LINE_NO_APPROVED_VERSION",
  NO_QUANTITY: "QUOTATION_LINE_NO_APPROVED_QUANTITY",
  /* The line names a quantity other than the one Sales confirmed. Its own
     code, because the thing to do about it — reload and price the agreed
     quantity — differs from every other refusal here. */
  QUANTITY_NOT_CONFIRMED: "QUOTATION_LINE_QUANTITY_NOT_CONFIRMED",
  /* ── MALFORMED IS NOT DISAGREEMENT ───────────────────────────────────
     "several" is not a quantity that conflicts with 750; it is not a
     quantity. Compared numerically it becomes NaN, which differs from
     everything, so it would be reported as a disagreement — and answered
     with "re-read the order", which fixes nothing. Refused as the malformed
     input it is, before any comparison. */
  QUANTITY_INVALID: "QUOTATION_LINE_QUANTITY_INVALID",
  /* Each state is a different thing for Sales to do: nobody has confirmed a
     quantity, two lines could be meant, the line named is not on this style,
     or the costing has not caught up with it. Collapsing them into one
     refusal would tell somebody "that did not work" and nothing more. */
  NO_COMMERCIAL_LINE: "QUOTATION_LINE_NO_COMMERCIAL_LINE",
  AMBIGUOUS_LINE: "QUOTATION_LINE_COMMERCIAL_LINE_AMBIGUOUS",
  LINE_NOT_FOUND: "QUOTATION_LINE_COMMERCIAL_LINE_NOT_FOUND",
  LINE_OUT_OF_SYNC: "QUOTATION_LINE_COSTING_NOT_IN_SYNC",
  INTENT_REQUIRED: "QUOTATION_LINE_COSTING_INTENT_REQUIRED",
  CURRENCY: "QUOTATION_LINE_CURRENCY_MISMATCH",
  NO_TIER: "QUOTATION_LINE_TIER_REQUIRED",
  SUPERSEDED: "QUOTATION_SOURCE_SUPERSEDED",
  UNVERIFIABLE: "QUOTATION_SOURCE_UNVERIFIABLE",
  CHANGED: "QUOTATION_SOURCE_CHANGED",
  /* ── A TIER ASKED OF A ONE-FLOOR COSTING ─────────────────────────────
     Its own code, so a client can tell "this costing has no target price"
     (a company-policy change it must react to) from "this quantity is not
     approved" (a different problem with a different fix). */
  TIER_RETIRED: "QUOTATION_LINE_PRICE_TIER_RETIRED",
  /* ── THE SALES DECISION BEHIND THIS LINE HAS MOVED ───────────────────
     A Sales-origin line is priced from the commercial decision frozen on the
     customer request. If the enquiry's approved state no longer matches that
     decision, the proforma is a document about a state that has passed: the
     fix is the explicit revision/supersession path, not a quiet re-price. */
  DECISION_CHANGED: "QUOTATION_LINE_SALES_DECISION_CHANGED",
  /* The enquiry the request was raised from cannot be read under the acting
     company. Answered as a missing request, never as a forbidden one. */
  DECISION_UNREADABLE: "QUOTATION_LINE_SALES_DECISION_UNREADABLE",
});

/* ── THE RETIRED TIERS, STILL ACCEPTED FOR HISTORICAL COSTINGS ─────────────
 * A costing approved under the three-band policy still has these three prices
 * and a quotation may still be raised from one — those quotations are real and
 * the company still ships against them. What a tier no longer does is resolve
 * against a costing approved under the pricing floor: that returns
 * `PRICE_TIER_RETIRED` rather than quietly answering with the floor under a
 * tier's name. */
const TIERS = Object.freeze(["minimum", "target", "preferred"]);

/* The one price a costing approved under the pricing floor carries. Accepted
   alongside the retired tiers, never as one of them: which a costing has is a
   fact about the costing, and asking for the wrong one is refused by name
   rather than resolved to whatever price happens to be there. */
const FLOOR = "floor";
const PRICE_CHOICES = Object.freeze([FLOOR, ...TIERS]);

/* The service's own reason codes, mapped to the line-level ones Sales reads. */
const REASON_TO_CODE = Object.freeze({
  NO_STYLE: CODES.NO_STYLE,
  NO_COSTING: CODES.NO_COSTING,
  NO_APPROVED_VERSION: CODES.NO_APPROVAL,
  NO_SCENARIO_FOR_QUANTITY: CODES.NO_QUANTITY,
  CURRENCY_MISMATCH: CODES.CURRENCY,
  PRICE_TIER_RETIRED: CODES.TIER_RETIRED,
});

const present = (v) => v !== null && v !== undefined && v !== "";

/**
 * Minor units to the major-unit number the quotation model stores.
 *
 * ── ONCE, AND ONLY HERE ─────────────────────────────────────────────────────
 * The costing side is integer paise; the quotation model is a float rupee
 * amount. Converting in two places is how the two drift by a paisa and nobody
 * can say which is right, so every caller comes through this.
 */
const toMajor = (minor) => Math.round(Number(minor)) / 100;

/**
 * What the browser is allowed to say about an approved-costing price.
 *
 * Anything else it sent on the line is discarded before it can reach a
 * calculation or a stored field — see `stripClientProvenance`.
 */
function readIntent(item = {}) {
  const raw = item.costingIntent || null;
  if (!raw || typeof raw !== "object") return null;
  const sampleStyleId = present(raw.sampleStyleId) ? String(raw.sampleStyleId).trim() : "";
  if (!sampleStyleId) return null;
  const tier = String(raw.tier || "").trim().toLowerCase();
  /* ── WHICH PRODUCT LINE, NAMED BY THE CLIENT ──────────────────────────
     A style alone does not identify a commercial line: one enquiry carries
     the same garment twice in two colourways, each with its own confirmed
     quantity. The client says WHICH, and the server proves it — naming a
     line it does not own resolves to nothing and is refused. */
  const productLineRef = present(raw.productLineRef) ? String(raw.productLineRef).trim() : "";
  return { sampleStyleId, tier, productLineRef };
}

/**
 * Remove everything a client is not entitled to assert about pricing.
 *
 * ── DELETED, NOT VALIDATED ──────────────────────────────────────────────────
 * A forged `costingSource` is not rejected with a message — it is removed, and
 * then either replaced by one the server produced or absent. Validating it
 * would mean the shape a client sends decides whether the check runs, and the
 * shape is the thing under the client's control.
 */
function stripClientProvenance(item = {}) {
  const {
    costingSource, costingIntent, sampleStyleId,
    /* ── IDENTITY IS ASSERTED BY THE SERVER TOO ────────────────────────
       `productLineRef` is which commercial line the price came from, and
       `governed` is the editor's read of the decision behind it. Both are
       stamped back on by the governed path from the request's own record; a
       line that did not come through it keeps neither, so nothing can claim
       a provenance nobody resolved. */
    productLineRef, governed, priceSource,
    ...rest
  } = item;
  return rest;
}

/**
 * THE CONFIRMED COMMERCIAL LINE FOR THIS QUOTATION LINE, OR A TYPED REFUSAL.
 *
 * ── WHY THIS FAILS CLOSED ───────────────────────────────────────────────────
 * The first version of this returned "unknown" for a missing, ambiguous or
 * invalid line, and the caller only refused when a line WAS found and
 * disagreed. That is a verification a client can switch off: omit the product
 * line, or arrange two candidates, and the submitted quantity sailed through
 * unchecked. A check that can be avoided by sending less is not a check.
 *
 * So every outcome except a single, valid, in-sync line is a refusal, and each
 * one is its own reason — "no line", "two lines" and "the costing has not
 * caught up" are three different things for Sales to do.
 *
 * ── AND SYNC IS ASKED, NOT RESTATED ─────────────────────────────────────────
 * Whether the costing is running for the confirmed quantity is decided by
 * `commercialLine.costingQuantityFor`, the same authority the commercial-line
 * service uses. A second definition here would be a second answer, and the
 * second answer is the one that drifts.
 */
async function resolveCommercialLine(ctx, intent) {
  const styleId = String(intent?.sampleStyleId ?? "").trim();
  const lineRef = String(intent?.productLineRef ?? "").trim();
  if (!styleId) return { ok: false, reason: "NO_STYLE" };

  const SampleStyle = require("../../models/CMS_Models/Sales/SampleStyle");
  const Enquiry = require("../../models/CMS_Models/Sales/Enquiry");
  const commercialLine = require("../sales/commercialLine.service");

  const style = await SampleStyle.findById(styleId).select("enquiryId").lean().catch(() => null);
  if (!style?.enquiryId) return { ok: false, reason: "NO_ENQUIRY" };

  /* Scoped to the acting company through the enquiry that owns the style. */
  /* Both: `costingQuantityFor` reads the briefs, and projecting them away
     would make every line look out of sync. */
  const enquiry = await Enquiry.findOne(serviceFilter(
    { companyId: ctx.companyId, reason: "the confirmed quantity for a quotation line" },
    { _id: style.enquiryId },
  )).select("commercialLines costingBriefs").lean().catch(() => null);
  if (!enquiry) return { ok: false, reason: "NO_ENQUIRY" };

  const all = enquiry.commercialLines || [];
  const forStyle = all.filter((l) => String(l.sampleStyleId || "") === styleId);
  if (!forStyle.length) return { ok: false, reason: "NO_COMMERCIAL_LINE" };

  /* ── THE EXACT PAIR ─────────────────────────────────────────────────
     Both halves, together. A style with two colourways has two lines; a
     `productLineRef` naming a line on another style is not this line. */
  /* A client that named no reference is still answerable where the style has
     exactly one line — it falls out of the same count, with no separate rule
     to keep in step. Two candidates is a refusal either way: guessing between
     them is the defect this exists to close. */
  const matches = lineRef
    ? forStyle.filter((l) => String(l.productLineRef || "") === lineRef)
    : forStyle;

  if (!matches.length) return { ok: false, reason: "COMMERCIAL_LINE_NOT_FOUND" };
  if (matches.length > 1) {
    return { ok: false, reason: "AMBIGUOUS_COMMERCIAL_LINE", candidates: matches.length };
  }

  const line = matches[0];
  const quantity = Number(line.quantity);
  if (!Number.isFinite(quantity) || quantity <= 0) {
    return { ok: false, reason: "COMMERCIAL_LINE_INVALID" };
  }

  /* The costing must be running for THAT quantity — asked of the authority. */
  const costingQuantity = commercialLine.costingQuantityFor(enquiry, line.sampleStyleId);
  if (costingQuantity === null || Number(costingQuantity) !== quantity) {
    return { ok: false, reason: "COSTING_NOT_IN_SYNC", quantity };
  }

  return { ok: true, quantity, productLineRef: String(line.productLineRef || "") };
}

/**
 * Does this style have a commercial line at all?
 *
 * Used to close the manual bypass: a style governed by this flow may not be
 * priced by simply omitting `costingIntent`.
 */
async function styleIsGoverned(ctx, sampleStyleId) {
  const styleId = String(sampleStyleId ?? "").trim();
  if (!styleId) return false;
  const SampleStyle = require("../../models/CMS_Models/Sales/SampleStyle");
  const Enquiry = require("../../models/CMS_Models/Sales/Enquiry");
  const style = await SampleStyle.findById(styleId).select("enquiryId").lean().catch(() => null);
  if (!style?.enquiryId) return false;
  const enquiry = await Enquiry.findOne(serviceFilter(
    { companyId: ctx.companyId, reason: "whether a style is governed by a commercial line" },
    { _id: style.enquiryId },
  )).select("commercialLines").lean().catch(() => null);
  return Boolean((enquiry?.commercialLines || []).some(
    (l) => String(l.sampleStyleId || "") === styleId,
  ));
}

/**
 * The GOVERNED style a line is for, however it names it — or "".
 *
 * ── THE SAME BYPASS THROUGH A DIFFERENT FIELD ───────────────────────────────
 * Refusing a manual price on a line that names `sampleStyleId` closes one
 * door. The editor builds its lines from `stockItemId` — an item-master
 * product — and a line that names ONLY that is for the same garment. Left
 * unresolved, dropping two fields instead of one would put a typed price on a
 * style the company has a floor for.
 *
 * The join is the one that already exists: SampleStyle stores the item-master
 * product it became, and the link endpoint Sales reads is built from it. No
 * second mapping, and nothing matched by name.
 */
async function governedStyleFor(ctx, item) {
  if (present(item?.sampleStyleId)) {
    const named = String(item.sampleStyleId).trim();
    return (await styleIsGoverned(ctx, named)) ? named : "";
  }
  if (!present(item?.stockItemId)) return "";
  /* ── SCOPED THROUGH THE ENQUIRY, NOT ON THE STYLE ──────────────────
     SampleStyle carries no company of its own; ownership lives on the
     enquiry that owns it, which is where `styleIsGoverned` reads it. So the
     candidates are found by the stored link and each is then asked — a
     style belonging to another company answers "not governed", which is the
     same answer a style nobody has confirmed a quantity for gives. Neither
     tells the caller which it was. */
  const SampleStyle = require("../../models/CMS_Models/Sales/SampleStyle");
  const styles = await SampleStyle.find({
    "production.stockItemId": item.stockItemId,
    isActive: true,
  }).select("_id").lean().catch(() => []);
  for (const style of styles || []) {
    if (await styleIsGoverned(ctx, String(style._id))) return String(style._id);
  }
  return "";
}

/**
 * Price one quotation line.
 *
 * @returns {{ok: true, patch: object} | {ok: false, error: object}}
 */
/* ══ THE SALES-ORIGIN GOVERNED LINE ═══════════════════════════════════════
 *
 * ── WHAT THE PROFORMA EDITOR WAS DOING ──────────────────────────────────────
 * It opened a blank document shell. Quantity from the request, and then
 * `unitPrice: 0, basePrice: 0` — so a proforma raised on REQ-2026-0001, whose
 * own record says 750 pieces at ₹120 approved by executive exception for
 * ₹90,000, opened at ₹0 with "Manual price — not linked to an approved
 * costing" underneath it, and asked Sales to type the figure again.
 *
 * ── WHY THE TIER MACHINERY CANNOT PRICE IT ──────────────────────────────────
 * The approved-costing path answers "which of the costing's own prices do you
 * want" — the floor, or one of the retired bands. That is the right question
 * for a quotation being priced FROM a costing. It is the wrong question here:
 * the enquiry's commercial review has already decided what this customer is
 * charged, and an executive exception means the agreed figure is deliberately
 * BELOW the floor. Asking for "the floor" would quote ₹152 and stamp it as
 * approved — a different price from the one anybody agreed.
 *
 * So a Sales-origin line is priced from the decision the proforma command
 * froze onto the request, and that decision is re-verified here against the
 * issuance authority before it is used. Not trusted because it is stored:
 * between the raise and the save, the enquiry can be re-priced and re-approved.
 */

/** The request item this quotation line is for, by permanent identity. */
function governedItemFor(request, item) {
  if (!request?.salesOrigin?.enquiryId) return null;

  const styleId = present(item.sampleStyleId) ? String(item.sampleStyleId) : "";
  const lineRef = present(item.productLineRef) ? String(item.productLineRef) : "";
  const intent = readIntent(item);
  const intentStyle = intent?.sampleStyleId || "";
  const intentRef = intent?.productLineRef || "";

  const governed = (request.items || []).filter((r) => r?.commercialDecision?.unitPriceMinor != null);
  if (!governed.length) return null;

  /* ── STYLE FIRST, THEN THE LINE REFERENCE ─────────────────────────────
     A style identifies a colourway; the line reference identifies which row
     of the enquiry it is. Matching on the stock item alone would pair two
     colourways that share a finished good, which is the failure every key in
     this flow is shaped to avoid — so a line that cannot be matched on style
     or reference is not treated as governed at all, and falls through to the
     path it came from. */
  const byStyle = governed.filter((r) => {
    const s = String(r.sampleStyleId || "");
    return s && (s === styleId || s === intentStyle);
  });
  const byRef = governed.filter((r) => {
    const s = String(r.productLineRef || "");
    return s && (s === lineRef || s === intentRef);
  });

  const candidates = byStyle.length && byRef.length
    ? byStyle.filter((r) => byRef.includes(r))
    : (byStyle.length ? byStyle : byRef);

  if (candidates.length === 1) return candidates[0];
  /* Two rows answering one line is never resolved by picking one. */
  return candidates.length > 1 ? "AMBIGUOUS" : null;
}

/**
 * Price one Sales-origin line from its own commercial decision.
 *
 * Reads NOTHING from the submitted line except its identity: not the price,
 * not the quantity, not a tier, not a provenance.
 */
async function priceGovernedLine(ctx, request, requestItem, item, { currency, index }) {
  const clean = stripClientProvenance(item);
  const decision = requestItem.commercialDecision || {};
  const lineName = item.itemName || requestItem.stockItemName || "";

  const productLineRef = String(requestItem.productLineRef || "");
  const sampleStyleId = String(requestItem.sampleStyleId || "");

  /* ── COMPANY FIRST, AND A FOREIGN ONE IS SIMPLY NOT FOUND ────────────
     A CustomerRequest carries no company of its own; the enquiry it was
     raised from does. Read under the acting company's scope, so a request
     belonging to another company answers exactly as a request that does not
     exist — a refusal that varies with the answer is a way to enumerate
     other companies' orders. */
  let enquiry = null;
  try {
    enquiry = await mongoose.model("Enquiry").findOne(serviceFilter(
      { companyId: ctx.companyId, reason: "the approved selling price behind a proforma line" },
      { _id: request.salesOrigin.enquiryId, isActive: true },
    )).lean();
  } catch (err) {
    enquiry = null;
  }
  if (!enquiry) {
    return {
      ok: false,
      error: {
        code: CODES.DECISION_UNREADABLE, index, lineName,
        notFound: true,
        message: "Request not found",
      },
    };
  }

  /* ── THE STORED DECISION IS CHECKED, NOT TRUSTED ─────────────────────
     `issuanceFor` is the authority that allowed the proforma to be raised.
     Asking it again is what makes the saved document a statement about the
     state as it is now, rather than as it was when somebody pressed a
     button. */
  let ready = null;
  try {
    ready = await lineReadiness.issuanceFor(ctx, enquiry, { productLineRef, sampleStyleId });
  } catch (err) {
    ready = null;
  }
  if (!ready) {
    return {
      ok: false,
      error: {
        code: CODES.UNVERIFIABLE, index, lineName, retryable: true,
        message: "The approved price behind this line could not be checked. Try again.",
      },
    };
  }

  const moved = !ready.ok
    || Number(ready.unitPriceMinor) !== Number(decision.unitPriceMinor)
    || Number(ready.quantity) !== Number(decision.quantity)
    || String(ready.costingVersionId || "") !== String(decision.costingVersionId || "");
  if (moved) {
    return {
      ok: false,
      error: {
        code: CODES.DECISION_CHANGED, index, lineName,
        message: "The approved commercial decision behind this line has changed since this proforma "
          + "was raised. Raise a revision from Cost & Invoicing — a proforma cannot be re-priced in "
          + "place.",
      },
    };
  }

  /* ── AND THE SUBMITTED QUANTITY IS COMPARED, NEVER ADOPTED ───────────
     Malformed first, so "several" is reported as not-a-number rather than as
     a number that disagrees. */
  if (present(item.quantity)) {
    const asked = Number(item.quantity);
    if (!Number.isFinite(asked) || asked <= 0) {
      return {
        ok: false,
        error: {
          code: CODES.QUANTITY_INVALID, index, lineName,
          message: "This line's quantity is not a number. The quantity comes from the confirmed "
            + "commercial line, so send it as figures or leave it out.",
        },
      };
    }
    if (asked !== Number(decision.quantity)) {
      return {
        ok: false,
        error: {
          code: CODES.QUANTITY_NOT_CONFIRMED, index, lineName,
          message: `This line says ${item.quantity}, but the confirmed commercial quantity is `
            + `${decision.quantity}. Re-read the order and price the quantity that was agreed.`,
          confirmedQuantity: Number(decision.quantity),
          submittedQuantity: asked,
        },
      };
    }
  }

  /* The price, by contrast, is REPLACED rather than compared: the company
     owns what it charges, and a figure typed over an approved one is noise
     rather than a second opinion. */
  const unitPrice = toMajor(ready.unitPriceMinor);

  return {
    ok: true,
    sourced: true,
    patch: {
      ...clean,
      quantity: Number(ready.quantity),
      unitPrice,
      /* Both, so the "price up, never down" clamp downstream cannot hold the
         line at a stale figure. */
      basePrice: unitPrice,
      sampleStyleId: requestItem.sampleStyleId,
      productLineRef,
      costingSource: {
        source: "APPROVED_COSTING",
        /* WHAT THE DOCUMENT MAY SAY: which costing version approved the
           price, for how many, at what figure, when, and how it was cleared.
           The floor it was measured against and the cost behind it are not
           here, and must never be: this record is read by a customer-facing
           document. */
        priceBasis: "SALES_APPROVED_DECISION",
        approvalKind: ready.approvedByException ? "EXECUTIVE" : "COMMERCIAL",
        costingId: decision.costingId,
        costingVersionId: ready.costingVersionId,
        costingVersionNumber: ready.costingVersionNumber,
        sampleStyleId: requestItem.sampleStyleId,
        scenarioKey: ready.scenarioKey,
        quantity: String(ready.quantity),
        unitPriceMinor: Number(ready.unitPriceMinor),
        currency: currency || "INR",
        linkedAt: new Date(),
        approvedAt: ready.approvedAt || decision.approvedAt || null,
      },
    },
  };
}

async function priceLine(ctx, item, { currency, index, request = null }) {
  /* ── A GOVERNED LINE IS NOT OFFERED THE OTHER PATHS ──────────────────
     Before the intent is even read: a Sales-origin line's price is already
     decided, so neither a tier nor a typed figure is a question this line
     has. Placed first so no client shape — an omitted intent, a forged one,
     a manual switch — can route it anywhere else. */
  const governedItem = governedItemFor(request, item);
  if (governedItem === "AMBIGUOUS") {
    return {
      ok: false,
      error: {
        code: CODES.AMBIGUOUS_LINE, index, lineName: item.itemName || "",
        message: "This line matches more than one approved product line on the request. "
          + "Name the product line this proforma line is for.",
      },
    };
  }
  if (governedItem) return priceGovernedLine(ctx, request, governedItem, item, { currency, index });

  const intent = readIntent(item);
  const clean = stripClientProvenance(item);

  /* ── A MANUAL LINE KEEPS THE WORKFLOW IT HAD ──────────────────────────
     No intent means the existing manual path, unchanged: the submitted price
     stands and the line carries NO provenance. Switching deliberately from an
     approved price to a manual one lands here, and the old `costingSource`
     is gone because it was stripped and nothing replaced it — it cannot stay
     attached to a freshly typed figure. */
  if (!intent) {
    /* ── OMITTING THE INTENT IS NOT A WAY ROUND THE CHECK ──────────────
       A manual line is still the ordinary path for a garment nobody has
       costed. But once a style HAS a confirmed commercial line, it is
       governed by this flow, and pricing it by hand would put a typed
       figure on a document the company has a floor for. Refused by name, so
       the reader is told to use the approved price rather than that their
       request was malformed.

       Stored historical quotations are untouched by this: it runs only when
       a line is being priced now. */
    if (await governedStyleFor(ctx, item)) {
      return {
        ok: false,
        error: {
          code: CODES.INTENT_REQUIRED,
          index,
          lineName: item.itemName || "",
          message: "This style has a confirmed commercial quantity, so its price comes from the "
            + "approved costing. Choose the approved price instead of typing one.",
        },
      };
    }
    return { ok: true, patch: clean, sourced: false };
  }

  if (!PRICE_CHOICES.includes(intent.tier)) {
    return {
      ok: false,
      error: {
        code: CODES.NO_TIER, index, lineName: item.itemName || "",
        message: "Choose which approved price to use: the floor price, or — on a costing approved "
          + "under the retired band — its minimum, target or preferred.",
      },
    };
  }

  /* ── AND THE QUANTITY MUST BE THE ONE SALES CONFIRMED ──────────────────
     ── WHY THE SUBMITTED NUMBER IS NOT ENOUGH ─────────────────────────
     The price on this line is resolved server-side and replaces whatever was
     posted. The QUANTITY was not: it came straight off the request body, so
     a stale tab, a replayed request or a direct call could quote 500 against
     a costing the company calculated for 750 — and every figure on the
     document would be internally consistent and wrong.

     Every state except a single, valid, in-sync commercial line is a refusal.
     A verification that steps aside when the client sends less is not a
     verification. */
  const commercial = await resolveCommercialLine(ctx, intent);
  if (!commercial.ok) {
    const code = {
      NO_COMMERCIAL_LINE: CODES.NO_COMMERCIAL_LINE,
      NO_ENQUIRY: CODES.NO_COMMERCIAL_LINE,
      NO_STYLE: CODES.NO_STYLE,
      AMBIGUOUS_COMMERCIAL_LINE: CODES.AMBIGUOUS_LINE,
      COMMERCIAL_LINE_NOT_FOUND: CODES.LINE_NOT_FOUND,
      COMMERCIAL_LINE_INVALID: CODES.NO_COMMERCIAL_LINE,
      COSTING_NOT_IN_SYNC: CODES.LINE_OUT_OF_SYNC,
    }[commercial.reason] || CODES.NO_COMMERCIAL_LINE;

    const message = {
      NO_COMMERCIAL_LINE: "No commercial quantity has been confirmed for this style. "
        + "Confirm the quantity in Cost & Invoicing before pricing it.",
      NO_ENQUIRY: "No commercial quantity has been confirmed for this style. "
        + "Confirm the quantity in Cost & Invoicing before pricing it.",
      NO_STYLE: "This line names no style, so no confirmed quantity can be found for it.",
      AMBIGUOUS_COMMERCIAL_LINE: "This style has more than one confirmed commercial line. "
        + "Name the product line this quotation is for.",
      COMMERCIAL_LINE_NOT_FOUND: "That product line has no confirmed commercial quantity on this style.",
      COMMERCIAL_LINE_INVALID: "The confirmed commercial quantity for this style cannot be read.",
      COSTING_NOT_IN_SYNC: "The costing for the confirmed quantity has not completed, "
        + "so there is no price to quote yet.",
    }[commercial.reason] || "No confirmed commercial quantity could be resolved for this line.";

    return {
      ok: false,
      error: {
        code, index, lineName: item.itemName || "", message,
        reason: commercial.reason,
        ...(commercial.candidates ? { candidates: commercial.candidates } : {}),
      },
    };
  }

  /* Malformed first, so a value that is not a number is never reported as a
     number that disagrees. */
  if (present(item.quantity)) {
    const asked = Number(item.quantity);
    if (!Number.isFinite(asked) || asked <= 0) {
      return {
        ok: false,
        error: {
          code: CODES.QUANTITY_INVALID,
          index,
          lineName: item.itemName || "",
          message: "This line's quantity is not a number. The quantity comes from the confirmed "
            + "commercial line, so send it as figures or leave it out.",
        },
      };
    }
  }

  /* A mismatch is refused rather than silently corrected: a price may be
     replaced because the company owns the price, but how many a customer is
     buying is a commercial fact somebody agreed. */
  if (present(item.quantity) && Number(item.quantity) !== Number(commercial.quantity)) {
    return {
      ok: false,
      error: {
        code: CODES.QUANTITY_NOT_CONFIRMED,
        index,
        lineName: item.itemName || "",
        message: `This line says ${item.quantity}, but the confirmed commercial quantity is `
          + `${commercial.quantity}. Re-read the order and price the quantity that was agreed.`,
        confirmedQuantity: commercial.quantity,
        submittedQuantity: Number(item.quantity),
      },
    };
  }

  /* ── FROM HERE, THE SERVER'S NUMBER ─────────────────────────────────
     Not the body's, even where the two agree — so there is one source for
     the figure that reaches the costing lookup and the stored line. */
  const quantity = String(commercial.quantity);

  const link = await approvedOutput.resolveLinkForLine(ctx, {
    sampleStyleId: intent.sampleStyleId,
    quantity,
    currency,
    tier: intent.tier,
  });

  if (!link.available) {
    return {
      ok: false,
      error: {
        code: REASON_TO_CODE[link.reason] || CODES.NO_COSTING,
        index,
        lineName: item.itemName || "",
        message: link.message,
        /* What IS approved, where the refusal is about quantity — so Sales
           can see the gap rather than guess at it. */
        ...(link.availableQuantities ? { availableQuantities: link.availableQuantities } : {}),
        ...(link.approvedCurrency ? { approvedCurrency: link.approvedCurrency } : {}),
      },
    };
  }

  const p = link.provenance;
  const unitPrice = toMajor(p.unitPriceMinor);

  return {
    ok: true,
    sourced: true,
    patch: {
      ...clean,
      /* ── THE APPROVED FIGURE REPLACES WHATEVER WAS POSTED ─────────────
         Both `unitPrice` and `basePrice`: the floor rule takes the greater of
         the two, so leaving a stale higher `basePrice` behind would quietly
         hold the line above the price the costing approved. */
      unitPrice,
      basePrice: unitPrice,
      /* ── AND THE CONFIRMED QUANTITY, NOT THE SUBMITTED ONE ──────────
         The two were just compared and agree, so this changes no number
         today. It decides WHICH COPY of the number is stored: the one read
         from the commercial line under this request's own company scope,
         rather than the one the client typed. A line that reached here can
         then never carry a quantity that was not confirmed, whatever a
         later edit to the comparison does. */
      quantity: commercial.quantity,
      sampleStyleId: p.sampleStyleId,
      costingSource: {
        source: p.source,
        costingId: p.costingId,
        costingVersionId: p.costingVersionId,
        costingVersionNumber: p.costingVersionNumber,
        sampleStyleId: p.sampleStyleId,
        styleCode: p.styleCode,
        productName: p.productName,
        scenarioKey: p.scenarioKey,
        quantity: p.quantity,
        priceTier: p.priceTier,
        unitPriceMinor: p.unitPriceMinor,
        currency: p.currency,
        linkedAt: p.linkedAt,
        approvedAt: p.approvedAt,
        assumptions: p.assumptions,
        fingerprint: p.fingerprint,
      },
    },
  };
}

/**
 * The refusals that are a CONFLICT WITH CONFIRMED COMMERCIAL STATE.
 *
 * ── WHY THESE TWO AND NOT THE REST ──────────────────────────────────────────
 * Both say the same thing: the document submitted disagrees with what Sales
 * has confirmed right now. The line names a quantity nobody agreed, or the
 * costing has not caught up with the quantity they did agree. Neither is a
 * malformed request — the client said something well-formed that is no longer
 * true, and the fix is to re-read the current state, not to correct syntax.
 *
 * Everything else here stays unprocessable-entity: a missing tier, a line
 * naming no style, a currency that does not match, a style with no commercial
 * line at all. Those are incomplete or inapplicable inputs, and reloading
 * changes nothing about them.
 */
const CONFLICT_CODES = Object.freeze(new Set([
  CODES.QUANTITY_NOT_CONFIRMED,
  CODES.LINE_OUT_OF_SYNC,
  /* Same shape as the two above: a well-formed document about a commercial
     state that has since moved. Re-reading is the whole fix — through the
     revision path, which is what the message says. */
  CODES.DECISION_CHANGED,
]));

/**
 * One refusal envelope for a whole save, chosen by what the lines actually say.
 *
 * ── WHY THE STATUS IS DECIDED HERE ──────────────────────────────────────────
 * Two save doors post quotation lines. A status chosen separately at each
 * would be two answers to one question, and the second would drift. Both ask
 * this.
 *
 * ── AND WHY A MIXED REQUEST IS NOT A CONFLICT ───────────────────────────────
 * 409 tells a caller "re-read the current state and try again". That is
 * honest advice only when re-reading is the whole fix. If ANY line is also
 * malformed, reloading will not make the request valid, so the request as a
 * whole is unprocessable and says so. Every line's own refusal is carried
 * either way, so nothing is lost by the summary being the cautious one.
 *
 * The refusal is always for the WHOLE request: no line is written when any
 * line is refused.
 */
function refusalFor(errors = []) {
  const allConflict = errors.length > 0
    && errors.every((e) => CONFLICT_CODES.has(e.code));
  if (allConflict) {
    return {
      status: 409,
      body: {
        success: false,
        code: "QUOTATION_COMMERCIAL_STATE_CONFLICT",
        message: "Some lines disagree with the confirmed commercial quantity. "
          + "Re-read the order and price the quantity that was agreed.",
        lines: errors,
      },
    };
  }
  return {
    status: 422,
    body: {
      success: false,
      code: "QUOTATION_COSTING_UNAVAILABLE",
      message: "Some lines could not be priced from an approved costing.",
      lines: errors,
    },
  };
}

/**
 * Must this save go through the pricing pass at all?
 *
 * ── WHY IT IS NOT "DOES ANY LINE CARRY AN INTENT" ───────────────────────────
 * It was, and that was the bypass. The pass is what verifies the quantity
 * against the confirmed commercial line, so gating the pass on a field the
 * client chooses to send meant a client could skip the verification by
 * sending less: drop `costingIntent`, keep the style, type a price, and no
 * commercial line was ever consulted.
 *
 * A line naming a style is enough to bring the save through the pass. Whether
 * that style is governed is then decided here, from the enquiry — not from
 * the request. Lines naming no style (freight, a sample charge) are untouched
 * and still save as they always did.
 */
/** Is this save about a customer request Sales raised from an enquiry? Every
 *  such request prices through the governed path, whatever the lines say. */
function isSalesOrigin(request) {
  return Boolean(request?.salesOrigin?.enquiryId)
    && (request.items || []).some((r) => r?.commercialDecision?.unitPriceMinor != null);
}

function needsPricingPass(items = []) {
  return (items || []).some((i) => Boolean(readIntent(i))
    || present(i?.sampleStyleId)
    /* The editor's own lines name an item-master product, not a style. A
       line that named only that was the same bypass through a different
       field, so it comes through the pass and the style is resolved from
       the link SampleStyle already stores. */
    || present(i?.stockItemId));
}

/** Price every line, collecting EVERY refusal rather than the first. */
async function priceLines(ctx, items = [], { currency, request = null }) {
  const out = [];
  const errors = [];
  for (let i = 0; i < items.length; i += 1) {
    const r = await priceLine(ctx, items[i], { currency, index: i, request });
    if (r.ok) out.push(r.patch);
    else { errors.push(r.error); out.push(stripClientProvenance(items[i])); }
  }
  return { items: out, errors };
}

/**
 * Is every sourced line on this quotation still safe to show a customer?
 *
 * ── RE-VERIFIED, NOT TRUSTED ────────────────────────────────────────────────
 * The stamp says what was true when the line was priced. Between then and
 * sending, the costing can be revised and re-approved, the quantity edited, or
 * the currency changed. Sending is the moment the number leaves the building,
 * so it is the moment to look again.
 *
 * Nothing is repaired here. A quotation is an offer, and silently sending a
 * different price from the one on screen is worse than refusing to send.
 */
async function verifyBeforeSend(ctx, quotation) {
  const problems = [];
  const items = quotation?.items || [];

  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    const src = item.costingSource && item.costingSource.source ? item.costingSource : null;
    /* Manual lines are unaffected — there is no source to have moved. */
    if (!src) continue;

    const line = { index: i, lineName: item.itemName || "", versionNumber: src.costingVersionNumber };

    let check;
    try {
      check = await approvedOutput.supersessionFor(ctx, src);
    } catch (err) {
      /* ── AN UNANSWERED CHECK IS NOT A PASS ──────────────────────────────
         If the source cannot be read, the honest answer is that we do not
         know — never "still current". Retryable, because the next attempt
         may reach it. */
      problems.push({
        ...line, code: CODES.UNVERIFIABLE, retryable: true,
        message: "The approved costing behind this line could not be checked. Try again.",
      });
      continue;
    }
    if (!check.checked || check.unknown) {
      problems.push({
        ...line, code: CODES.UNVERIFIABLE, retryable: true,
        message: "The approved costing behind this line could not be read. Try again.",
      });
      continue;
    }
    if (check.superseded) {
      problems.push({
        ...line, code: CODES.SUPERSEDED, retryable: false,
        currentApprovedVersionId: check.currentApprovedVersionId,
        message: "Approved source has been superseded. Reprice this line from the current approved "
          + "costing, or deliberately switch it to a manual price before sending.",
      });
      continue;
    }

    /* ── THE LINE ITSELF MAY HAVE MOVED ────────────────────────────────
       The costing can be perfectly current while the quantity was edited
       afterwards, which makes the stamped price one approved for a different
       run size. The fingerprint covers the ids and figures; the quantity and
       currency are compared against the line as it stands now. */
    if (!approvedOutput.sameQuantity(item.quantity, src.quantity)) {
      problems.push({
        ...line, code: CODES.CHANGED, retryable: false,
        message: `This line is now for ${item.quantity}, but its price was approved for ${src.quantity}. `
          + "Reprice it from the approved costing, or switch it to a manual price.",
      });
      continue;
    }
    const expected = approvedOutput.fingerprintOf({
      costingId: String(src.costingId),
      versionId: String(src.costingVersionId),
      scenarioKey: src.scenarioKey,
      tier: src.priceTier,
      priceMinor: src.unitPriceMinor,
      currency: src.currency,
    });
    if (src.fingerprint && expected !== src.fingerprint) {
      problems.push({
        ...line, code: CODES.CHANGED, retryable: false,
        message: "This line's recorded approved price no longer matches its own source details. "
          + "Reprice it from the approved costing before sending.",
      });
      continue;
    }
    /* And the price on the line must still be the approved one, not a figure
       edited afterwards while the stamp stayed behind. */
    if (Math.abs(toMajor(src.unitPriceMinor) - (Number(item.unitPrice) || 0)) > 0.005) {
      problems.push({
        ...line, code: CODES.CHANGED, retryable: false,
        message: "This line's price has been changed since it was taken from the approved costing. "
          + "Reprice it, or switch it to a manual price.",
      });
    }
  }

  return { ok: problems.length === 0, problems };
}

/**
 * One refusal shape for both send doors, chosen by what actually went wrong.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * Both doors returned a single envelope — 409 `QUOTATION_SOURCE_SUPERSEDED`,
 * "Some lines are priced from an approved costing that has changed" — for
 * EVERY refusal `verifyBeforeSend` produced. The per-line codes were correct
 * inside `problems`, but the envelope is what a client keys on, so:
 *
 *   · a line whose PRICE was edited after being sourced was reported as its
 *     costing having been superseded, sending somebody to re-approve a
 *     costing that had not moved;
 *   · a source that could not be READ was reported the same way — as a
 *     definite finding of change, when the honest answer is "we do not know".
 *     That one matters most: superseded is permanent and needs a decision,
 *     unverifiable is transient and needs a retry, and telling them apart is
 *     the difference between fixing a quotation and waiting a minute.
 *
 * A thrown check is already 503/UNVERIFIABLE at both call sites; this covers
 * the case where the check RETURNED an unverifiable verdict, which is the same
 * fact arriving by the other route.
 *
 * @returns {{status: number, body: object}}
 */
function sendRefusalFor(verdict) {
  const problems = verdict?.problems || [];
  /* Unverifiable first: an unanswered question outranks an answered one,
     because retrying may still turn it into a pass. */
  if (problems.some((p) => p.code === CODES.UNVERIFIABLE)) {
    return {
      status: 503,
      body: {
        success: false,
        code: CODES.UNVERIFIABLE,
        message: "The approved costing behind some lines could not be checked, so nothing was sent. Try again.",
        retryable: true,
        lines: problems,
      },
    };
  }
  if (problems.some((p) => p.code === CODES.SUPERSEDED)) {
    return {
      status: 409,
      body: {
        success: false,
        code: CODES.SUPERSEDED,
        message: "Some lines are priced from an approved costing that has since been superseded.",
        retryable: false,
        lines: problems,
      },
    };
  }
  return {
    status: 409,
    body: {
      success: false,
      code: CODES.CHANGED,
      message: "Some lines no longer match the approved costing they were priced from.",
      retryable: false,
      lines: problems,
    },
  };
}

/**
 * The costing company for the signed-in actor.
 *
 * The quotation router has no costing context of its own, and `CustomerRequest`
 * carries no company. Derived from the AUTHENTICATED ACTOR, exactly as the
 * costing routes do — never from the request body, and never from the style,
 * which is the thing being proved.
 */
async function contextFor(user) {
  const ctx = await companyContext.resolveForActor(user, {});
  return { companyId: ctx.companyId, actorId: ctx.actorId };
}

module.exports = {
  isSalesOrigin,
  needsPricingPass, CONFLICT_CODES, refusalFor,
  FLOOR, PRICE_CHOICES,
  CODES, TIERS, toMajor, readIntent, stripClientProvenance,
  priceLine, priceLines, verifyBeforeSend, sendRefusalFor, contextFor,
};

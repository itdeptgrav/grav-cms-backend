// services/sales/commercialLine.service.js
//
// THE QUANTITY A GARMENT IS PRICED FOR, AND THE ONE PLACE IT LIVES.
//
// ── THE DEFECT THIS CLOSES ──────────────────────────────────────────────────
// The number Central Costing calculates against was being read from whichever
// record a screen happened to reach for: the buyer's asked-for quantity on
// `products[]`, or a quantity typed into a "Costing Brief" that Sales had to
// understand and operate. Neither is a commercial decision anybody owns, and
// the two could disagree — which means a floor price could be calculated for a
// quantity nobody had settled on.
//
// One line, one quantity, one owner. Sales confirms it in Cost & Invoicing.
//
// ── AND THE BRIEF BECOMES INTERNAL PLUMBING ─────────────────────────────────
// `costingBrief.service` stays the authority that Central Costing reads: it
// validates the style, mints the revision, supersedes what it replaces and
// feeds the source fingerprint that makes a frozen version go stale. None of
// that is re-implemented here. What changes is WHO operates it — this service
// writes through it on Sales' behalf, so a salesperson confirms a quantity and
// never sees a brief.
//
// ── WHAT IT DELIBERATELY DOES NOT NEED ──────────────────────────────────────
// A portal customer. A prospect is still a prospect while their order is being
// priced, and requiring a linked customer to learn a cost would stop the work
// at the moment it is most needed. Linking one is required to ISSUE a proforma
// invoice and at no earlier moment.
//
// A selling price. Sales decides that AFTER seeing the floor. Copying the
// floor into it would make the company's own minimum look like a quote
// somebody chose.
"use strict";

const mongoose = require("mongoose");

const { fail } = require("../storePurchase/errors");
const costingBrief = require("./costingBrief.service");

const str = (v) => String(v ?? "").trim();
const isId = (v) => Boolean(v) && mongoose.Types.ObjectId.isValid(String(v));
const model = (name, path) => (mongoose.models[name] || require(path));
const Enquiry = () => model("Enquiry", "../../models/CMS_Models/Sales/Enquiry");

const CODES = Object.freeze({
  NOT_FOUND: "NOT_FOUND",
  VALIDATION: "COMMERCIAL_LINE_VALIDATION",
  LINE_NOT_FOUND: "COMMERCIAL_LINE_NOT_FOUND",
});

const MAX_QUANTITY = 10_000_000;

/**
 * One line, as Sales reads it.
 *
 * ── NO COST, NO PRICE, NO BRIEF ─────────────────────────────────────────────
 * The quantity, the unit, which revision it is, and what it has been. Nothing
 * about what any of it costs, and no trace of the record this service drives
 * underneath — a screen that could see a `briefId` would eventually show one.
 */
function lineView(l = {}) {
  return {
    productLineRef: str(l.productLineRef),
    sampleStyleId: l.sampleStyleId ? String(l.sampleStyleId) : null,
    productName: str(l.productName),
    quantity: Number(l.quantity) || null,
    quantityUom: str(l.quantityUom) || "Pieces",
    revision: Number(l.revision) || 1,
    confirmedAt: l.confirmedAt || null,
    confirmedByName: str(l.confirmedBy?.name),
    /* Oldest first, and every one of them. A quotation already issued was
       priced on a costing frozen for one of these numbers. */
    revisions: (l.revisions || []).map((r) => ({
      revision: Number(r.revision),
      quantity: Number(r.quantity),
      quantityUom: str(r.quantityUom) || "Pieces",
      reason: str(r.reason),
      at: r.at,
      byName: str(r.byName),
    })),
  };
}

async function loadOwnedEnquiry(ctx, enquiryId) {
  if (!ctx?.companyId) throw fail("COMPANY_CONTEXT_UNAVAILABLE", "Your company could not be resolved.");
  if (!isId(enquiryId)) throw fail(CODES.NOT_FOUND, "That enquiry was not found.");
  const enquiry = await Enquiry().findOne({ _id: enquiryId, companyId: ctx.companyId, isActive: true });
  if (!enquiry) throw fail(CODES.NOT_FOUND, "That enquiry was not found.");
  return enquiry;
}

/**
 * WHAT QUANTITY THE COSTING IS CURRENTLY BEING RUN FOR.
 *
 * ── WHY THIS IS ASKED RATHER THAN ASSUMED ───────────────────────────────────
 * Writing the commercial line and driving the costing underneath it are two
 * writes. They land on the same Enquiry document but through two separately
 * loaded copies of it, so there is no single commit that covers both — the
 * costing authority loads and saves its own instance, and giving it a session
 * would mean changing the signature every other caller depends on.
 *
 * They are therefore made RECOVERABLE rather than atomic, which is the pattern
 * this repository already uses where a boundary cannot be closed: the line is
 * the decision and commits first, the costing follows it, and a failure in
 * between leaves the two visibly disagreeing rather than silently agreeing on
 * the wrong number. Confirming again re-drives the costing, so a retry heals
 * it — and until it is healed the screen is told, so it cannot show a floor
 * price calculated for a quantity nobody confirmed.
 */
function costingQuantityFor(enquiry, styleId) {
  const confirmed = (enquiry?.costingBriefs || []).find((b) => str(b.state) === "CONFIRMED"
    && String(b.sampleStyleId) === String(styleId));
  const q = (confirmed?.quantities || []).find((x) => x.isPrimary) || (confirmed?.quantities || [])[0];
  const n = Number(q?.quantity);
  return Number.isFinite(n) ? n : null;
}

/** The line, plus whether the costing underneath it is running for that number. */
/**
 * THE SALES-ENTERED SELLING PRICE FOR ONE EXACT LINE.
 *
 * ── KEYED ON THE PAIR, AND ONLY THE PAIR ────────────────────────────────────
 * Ledger rows carry a product NAME even when they are keyed by the permanent
 * reference, so an enquiry with the same garment in two colourways has two rows
 * with one name. Matching by name takes the first and prices one colourway from
 * the other's decision — which is how a customer-approved figure ended up on
 * the wrong stock item. There is no name fallback here for that reason: a row
 * that cannot be identified exactly has no price for this line.
 */
function sellingPriceFor(enquiry, productLineRef, sampleStyleId) {
  const ref = str(productLineRef);
  const styleId = str(sampleStyleId);
  if (!ref || !styleId) return null;
  const row = (enquiry?.costLedger || []).find((l) => str(l.productLineRef) === ref
    && String(l.sampleStyleId || "") === styleId) || null;
  const price = row?.price;
  if (price === null || price === undefined || price === "") return null;
  const n = Number(price);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function lineWithSync(enquiry, line) {
  const view = lineView(line);
  const costingQuantity = costingQuantityFor(enquiry, line.sampleStyleId);
  return {
    ...view,
    costing: {
      /* ── FAIL CLOSED ────────────────────────────────────────────────
         No costing yet, or one running for a different number, is NOT in
         sync. A screen that treated "no answer" as agreement would show a
         floor for a quantity nobody confirmed. */
      inSync: costingQuantity !== null && costingQuantity === Number(view.quantity),
      /* Whether it is running at all — absent is different from wrong. */
      requested: costingQuantity !== null,
    },
  };
}

/** Every commercial line on this enquiry. */
async function readLines(ctx, { enquiryId } = {}) {
  const enquiry = await loadOwnedEnquiry(ctx, enquiryId);
  return {
    enquiryId: String(enquiry._id),
    enquiryRef: str(enquiry.enquiryId),
    lines: (enquiry.commercialLines || []).map((l) => lineWithSync(enquiry, l)),
  };
}

function assertQuantity(quantity) {
  const n = Number(quantity);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
    throw fail(CODES.VALIDATION, "Confirm a whole quantity of at least one.",
      { field: "quantity", reason: "QUANTITY_REQUIRED" });
  }
  if (n > MAX_QUANTITY) {
    throw fail(CODES.VALIDATION, "That quantity is larger than this system will price.",
      { field: "quantity", reason: "QUANTITY_TOO_LARGE" });
  }
  return n;
}

/**
 * CONFIRM THE QUANTITY THIS PRODUCT IS BEING QUOTED FOR.
 *
 * Idempotent by value: confirming the quantity already in force changes
 * nothing and mints no revision, so a double-click or a replayed request
 * cannot produce a second revision or a second costing.
 *
 * @returns {Promise<{line, changed, costing}>}
 */
async function confirmQuantity(ctx, {
  enquiryId, productLineRef, sampleStyleId, quantity, reason = "", actor = null,
} = {}) {
  const enquiry = await loadOwnedEnquiry(ctx, enquiryId);
  const ref = str(productLineRef);
  const styleId = str(sampleStyleId);
  const wanted = assertQuantity(quantity);

  if (!ref) {
    throw fail(CODES.VALIDATION, "Name the product line this quantity is for.",
      { field: "productLineRef", reason: "LINE_REQUIRED" });
  }
  if (!isId(styleId)) {
    throw fail(CODES.VALIDATION, "Name the approved style being quoted.",
      { field: "sampleStyleId", reason: "STYLE_REQUIRED" });
  }

  /* ── THE LINE MUST BE ONE THIS ENQUIRY ACTUALLY HAS ──────────────────
     Keyed on the permanent reference, never on the product's name. A
     reference this enquiry does not carry is NOT FOUND rather than created:
     a commercial line invented by a request body is a line nobody agreed. */
  const product = (enquiry.products || []).find((p) => str(p.productLineRef) === ref) || null;
  if (!product) {
    throw fail(CODES.LINE_NOT_FOUND, "That product line is not on this enquiry.",
      { productLineRef: ref });
  }

  const now = new Date();
  const byName = str(actor?.name);
  const existing = (enquiry.commercialLines || [])
    .find((l) => str(l.productLineRef) === ref && String(l.sampleStyleId) === styleId) || null;

  /* ── CONFIRMING WHAT IS ALREADY IN FORCE IS NOT A CHANGE ─────────────
     No new revision, no new costing, and the caller is told so — a screen
     that showed "revised" for an unchanged number would teach people that
     the revision count means nothing. */
  const changed = !existing || Number(existing.quantity) !== wanted;

  if (!changed) {
    /* ── CONFIRMING THE SAME NUMBER IS THE RETRY ──────────────────────
       No revision is minted, but the costing IS re-driven: this is exactly
       the call that heals a line whose costing failed to follow it. The
       sync flag is read AFTER that, from a fresh copy, or it would report
       the state this call was made to fix. */
    const healed = await driveCosting(ctx, {
      enquiry, styleId, quantity: wanted, uom: str(existing.quantityUom) || "Pieces", actor, reason: "",
    });
    const fresh = await loadOwnedEnquiry(ctx, String(enquiry._id));
    return {
      line: lineWithSync(fresh, readLineOn(fresh, ref, styleId)),
      changed: false,
      costing: healed,
    };
  }

  const nextRevision = existing ? Number(existing.revision || 1) + 1 : 1;
  const uom = str(existing?.quantityUom) || str(product.quantityUom) || "Pieces";
  const entry = {
    revision: nextRevision,
    quantity: wanted,
    quantityUom: uom,
    reason: str(reason).slice(0, 500),
    at: now,
    byName,
  };

  if (existing) {
    existing.quantity = wanted;
    existing.revision = nextRevision;
    existing.quantityUom = uom;
    existing.confirmedAt = now;
    existing.confirmedBy = { id: str(actor?.id), name: byName };
    /* Append-only: what this line has been priced for is history, and a
       quotation already issued points into it. */
    existing.revisions.push(entry);
  } else {
    enquiry.commercialLines.push({
      productLineRef: ref,
      sampleStyleId: styleId,
      productName: str(product.product),
      quantity: wanted,
      quantityUom: uom,
      revision: nextRevision,
      confirmedAt: now,
      confirmedBy: { id: str(actor?.id), name: byName },
      revisions: [entry],
    });
  }

  await enquiry.save();

  /* ── AND THE COSTING FOLLOWS THE LINE ────────────────────────────────
     Written through the existing authority, on Sales' behalf, for THIS
     quantity. A previously frozen version priced for the old number goes
     stale by the same fingerprint rule every other source change obeys —
     nothing here reaches into a costing version to adjust it. */
  const costing = await driveCosting(ctx, {
    enquiry, styleId, quantity: wanted, uom, actor, reason: str(reason),
    /* Carried so a re-confirmed quantity keeps the price already decided for
       this line rather than dropping it and leaving the review unsubmittable. */
    sellingPrice: sellingPriceFor(enquiry, ref, styleId),
  });

  /* Re-read: `driveCosting` saved its own copy of this document, so the
     instance held here no longer knows what the brief says. */
  const after = await loadOwnedEnquiry(ctx, String(enquiry._id));
  return { line: lineWithSync(after, readLineOn(after, ref, styleId)), changed: true, costing };
}

/**
 * THE SELLING PRICE CHANGED, SO THE COSTING IT WILL BE JUDGED ON MUST TOO.
 *
 * ── WHY A PRICE CHANGE RE-DRIVES THE COSTING ────────────────────────────────
 * The commercial review decides on the figures a version FROZE — the floor it
 * calculated and the price the brief carried. A price typed after a version was
 * frozen is not on that version, so approving it would be approving a number
 * the approver was never shown, and a proforma binding to that approval would
 * stamp a price nobody decided.
 *
 * So a new price is a new decision to be reviewed: the brief is revised with it
 * and the costing re-prepared. Any approval that existed belonged to the old
 * figures and no longer covers this line, which is the honest outcome — and is
 * exactly what the proforma gate refuses on.
 *
 * ── AND IT IS NOT A SECOND WRITER OF THE PRICE ──────────────────────────────
 * The price itself stays where Sales put it, on the ledger row keyed by the
 * pair. This only carries it to the authority that freezes it.
 */
async function repriceLine(ctx, { enquiryId, productLineRef, sampleStyleId, actor = null, reason = "" } = {}) {
  const enquiry = await loadOwnedEnquiry(ctx, enquiryId);
  const ref = str(productLineRef);
  const styleId = str(sampleStyleId);
  const line = readLineOn(enquiry, ref, styleId);

  /* No confirmed line, nothing to reprice. Not an error: a price may be typed
     against a line whose quantity has not been confirmed yet, and that state
     is already refused by the selling-price gate itself. */
  if (!line) return { requested: false, reason: "LINE_NOT_FOUND" };

  const quantity = Number(line.quantity);
  if (!Number.isFinite(quantity) || quantity <= 0) {
    return { requested: false, reason: "QUANTITY_NOT_CONFIRMED" };
  }

  return driveCosting(ctx, {
    enquiry,
    styleId,
    quantity,
    uom: str(line.quantityUom) || "Pieces",
    actor,
    reason: str(reason) || `Selling price set for ${quantity} ${str(line.quantityUom) || "Pieces"}.`,
    sellingPrice: sellingPriceFor(enquiry, ref, styleId),
  });
}

const readLineOn = (enquiry, ref, styleId) => (enquiry.commercialLines || [])
  .find((l) => str(l.productLineRef) === ref && String(l.sampleStyleId) === styleId) || null;

/**
 * Write the confirmed quantity through to the record Central Costing reads.
 *
 * ── ONE AUTHORITY, DRIVEN — NOT A SECOND ONE ────────────────────────────────
 * Every rule about what may be costed stays where it was: the style must be on
 * this enquiry and approved, the quantity is parsed and bounded, the revision
 * is minted, and confirming supersedes whatever it replaces with a reason. This
 * only supplies the number and the style, and reports whether it took.
 *
 * A refusal is returned rather than thrown. The quantity IS confirmed by this
 * point — it is a commercial fact and stands on its own — and a costing that
 * cannot start yet is something the screen states, not something that undoes
 * the decision Sales just took.
 */
async function driveCosting(ctx, { enquiry, styleId, quantity, uom, actor, reason, sellingPrice = null }) {
  try {
    const saved = await costingBrief.saveBrief(ctx, {
      enquiryId: String(enquiry._id),
      /* A confirmed brief is never rewritten. Where one is already in force
         for this style, a fresh draft is started beside it and confirming
         that supersedes the old — which is exactly what a revised quantity
         is: a new decision, not an edit to the previous one. */
      revise: true,
      body: {
        sampleStyleId: styleId,
        quantityUom: uom,
        /* One quantity. Sales is quoting a number, not shopping a band —
           break points are a different feature and not this one. */
        /* ── AND THE PRICE SALES MEANS TO SELL AT, WHERE THERE IS ONE ──
           The brief is what a costing version freezes its `commercial`
           block from, and the commercial review decides on THAT frozen
           figure. A brief written without it produced a version with no
           proposed price, so the review could never be submitted and the
           proforma had nothing approved to bind to — which is how the PI
           came to read a price off the stock-item catalogue instead.

           Sent only when Sales has actually entered one. Absent stays
           absent: a costing may legitimately exist before anybody has
           decided what to charge, and inventing a price here would put a
           figure in front of an approver that nobody chose. */
        quantities: [{
          key: "commercial",
          label: String(quantity),
          quantity: String(quantity),
          isPrimary: true,
          ...(sellingPrice === null ? {} : { proposedSellingPriceExclTax: String(sellingPrice) }),
        }],
      },
      actor,
    });

    const draft = (saved?.briefs || []).find((b) => str(b.state) === "DRAFT"
      && String(b.sampleStyleId) === styleId);
    if (!draft) return { requested: false, reason: "NO_DRAFT" };

    await costingBrief.confirmBrief(ctx, {
      enquiryId: String(enquiry._id),
      briefId: str(draft.briefId),
      reason: reason || `Commercial quantity confirmed at ${quantity} ${uom}.`,
      actor,
    });
    return { requested: true, quantity, quantityUom: uom };
  } catch (err) {
    /* ── NOTHING HERE UNDOES THE DECISION ─────────────────────────────
       The quantity is committed by this point. Letting a failure escape
       would hand the caller an exception for a command that had in fact
       taken effect, and the obvious reading of that is "it did not work" —
       which is how somebody ends up confirming twice.

       A coded refusal is a state the screen can report in the authority's
       own words. Anything else is a bug, so it is logged rather than
       swallowed, and reported as a costing that has not started. Either
       way the line is out of sync and says so, and confirming again is the
       retry that heals it. */
    if (!err?.code) {
      console.error("[commercialLine] costing request failed:", err?.message || err);
      return { requested: false, reason: "COSTING_UNAVAILABLE", retryable: true };
    }
    /* Named, so a screen can say which desk answers it — and never a stack. */
    return { requested: false, reason: err.code, message: err.message };
  }
}

module.exports = {
  CODES, MAX_QUANTITY, lineView, costingQuantityFor, readLines, confirmQuantity,
  sellingPriceFor, repriceLine,
};

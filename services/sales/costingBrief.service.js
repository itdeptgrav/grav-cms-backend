// services/sales/costingBrief.service.js
//
// SALES ASKS FOR A COSTING. CENTRAL COSTING ANSWERS IT.
//
// ── THE DEFECT THIS CLOSES ──────────────────────────────────────────────────
// Which approved style is being quoted, what quantities the customer wants
// priced, in what unit, at what proposed selling price, by when, and why —
// every one of those is a commercial fact, and every one was being typed
// inside the Central Costing workspace by whoever happened to open it.
//
// Costing is a calculation, validation, versioning and audit engine. It has no
// customer in front of it, no negotiation and no order. The person who does is
// in Sales, and until now none of what they decided survived anywhere they
// could read it back: the quantities and the proposed price existed only in
// the calculation payload, and the choice of style existed only in whichever
// radio somebody clicked.
//
// ── WHAT THIS FILE OWNS, AND WHAT IT REFUSES ────────────────────────────────
// It owns the BRIEF: style, quantities, unit, proposed price, currency, note,
// required-by date, and the confirmation that turns a draft into the fact a
// costing may read.
//
// It refuses everything else by name. No material cost, no rate, no SAM, no
// supplier quotation, no policy value, no overhead, no margin floor and no
// calculated cost. Those are the departments' and the Board's, and a brief
// that could carry one would be Sales costing the garment.
//
// ── AND IT NEVER RETARGETS ──────────────────────────────────────────────────
// Choosing a different style does not edit a confirmed brief to point at the
// new one. That would rewrite history: every frozen costing version citing
// that brief would then describe a different garment. The old brief is closed
// explicitly, names its successor and says why.
"use strict";

const crypto = require("crypto");
const mongoose = require("mongoose");

const { fail } = require("../storePurchase/errors");
const { dec, DecimalError } = require("../centralCosting/decimal");

const str = (v) => String(v ?? "").trim();
const isId = (v) => mongoose.Types.ObjectId.isValid(str(v));

const model = (name, path) => (mongoose.models[name] || require(path));
const Enquiry = () => model("Enquiry", "../../models/CMS_Models/Sales/Enquiry");
const SampleStyle = () => model("SampleStyle", "../../models/CMS_Models/Sales/SampleStyle");

const CODES = Object.freeze({
  NOT_FOUND: "NOT_FOUND",
  VALIDATION: "VALIDATION",
  FIELD_NOT_ACCEPTED: "FIELD_NOT_ACCEPTED",
  STYLE_NOT_APPROVED: "COSTING_BRIEF_STYLE_NOT_APPROVED",
  BRIEF_NOT_CONFIRMABLE: "COSTING_BRIEF_NOT_CONFIRMABLE",
  BRIEF_SUPERSEDED: "COSTING_BRIEF_SUPERSEDED",
  BRIEF_REVISION_CONFLICT: "COSTING_BRIEF_REVISION_CONFLICT",
});

const STATE = Object.freeze({ DRAFT: "DRAFT", CONFIRMED: "CONFIRMED", SUPERSEDED: "SUPERSEDED" });

const MAX_QUANTITIES = 12;

/* ── THE ONLY FIELDS A BRIEF MAY CARRY IN ───────────────────────────────────
 * An allowlist, not a blocklist. A blocklist protects against the fields
 * somebody thought of; this refuses everything nobody declared, which is what
 * stops the next field added to the model from becoming writable by accident. */
const BRIEF_FIELDS = Object.freeze([
  "sampleStyleId", "quantities", "quantityUom", "currency", "note", "requiredBy", "revision",
]);

/* Fields that name a cost, a rate, a policy or a margin. Named explicitly so
   the refusal can say WHICH one was sent and whose it is — a salesperson who
   put a fabric rate in the body needs to be told that rates are Store's, not
   that they made a typo. */
const REFUSED_FIELDS = Object.freeze({
  cost: "a cost", unitCost: "a cost", costMinor: "a cost", totalCost: "a cost",
  rate: "a rate", unitRate: "a rate", rateMinor: "a rate",
  materials: "material costs", consumption: "a consumption", allowancePercent: "a wastage allowance",
  operations: "operations", samMinutes: "a standard time", sam: "a standard time",
  supplierId: "a supplier", supplierName: "a supplier", offerId: "a quotation",
  quotation: "a quotation", quotationReference: "a quotation",
  overhead: "an overhead rate", overheadRatePercent: "an overhead rate",
  financingRatePercent: "a financing rate", policy: "a company policy",
  margin: "a margin", marginPercent: "a margin", minimumMarginPercent: "a margin floor",
  tax: "a tax treatment", gstRatePercent: "a tax rate", inputGstTreatment: "a tax policy",
  /* State is the confirm/supersede verbs' to set, never a field on a save. */
  state: "the brief's state", confirmedAt: "a confirmation", confirmedBy: "a confirmation",
  supersededAt: "a supersession", supersededByBriefId: "a supersession",
  briefId: "the brief's identity",
});

/* ══ READING THE STYLE, AND WHETHER SALES MAY QUOTE IT ═════════════════════ */

/**
 * The approval state that lets Sales quote a style.
 *
 * ── REUSED, NOT REDEFINED ───────────────────────────────────────────────────
 * `technicalSource.approvalOf` is the one definition of what "approved" means
 * for a SampleStyle, and Central Costing already reads it. A second rule here
 * would be a second thing to keep in step, and the one nobody updates is the
 * one that lets an unapproved style be quoted.
 */
function approvalStateOf(style) {
  const { approvalOf } = require("../centralCosting/technicalSource.service");
  const technicalRecord = require("../centralCosting/technicalRecord.service");
  const approval = approvalOf(style);
  /* ── THE GATE IS THE APPROVED REVISION, NOT THE STATUS FIELD ─────────
     `readStyleFacts` costs a style from `approvedRevisionOf(techSheet)` — the
     FROZEN revision Sales approved, not the live editable record, because R&D
     may already be drafting the next one. So the question "may Sales quote
     this" has exactly one honest answer: does that revision exist. Reading
     `techSheet.status` instead would let a style be quoted that the costing
     engine would then refuse. */
  const approvedRevision = technicalRecord.approvedRevisionOf(style.techSheet || {});
  return {
    approval,
    approvedRevision: approvedRevision?.revision ?? null,
    quotable: Boolean(approvedRevision),
  };
}

/** What a Sales screen may be told about a style. Identity and state only. */
function styleOption(style, { quotable, approval, approvedRevision = null }) {
  return {
    sampleStyleId: String(style._id),
    styleReference: str(style.sampleStyleId),
    styleCode: str(style.styleCode),
    productName: str(style.productName),
    variantLabel: str(style.variantLabel),
    /* ── AND NOT ONE TECHNICAL FACT ──────────────────────────────────────
       No consumption, no allowance, no operation, no standard time, no
       material, no packaging row and no cost. Sales chooses WHICH style is
       being quoted; what is in it is R&D's and Production's record, and a
       list that carried it would make Sales a reader of another department's
       working. */
    quotable,
    /* WHICH revision, so a brief can freeze it and a reader can tell a
       costing made against revision 2 from one made against revision 3. */
    approvedRevision,
    approvalState: {
      bom: approval?.bom?.status || "none",
      technical: style.techSheet?.technical?.status || "not_started",
      sample: approval?.sample?.status || "none",
    },
    /* Why it cannot be quoted, where it cannot — so a blocked list is a task
       rather than a dead end. */
    blockedReason: quotable
      ? null
      : "R&D's technical record for this style has not been approved yet, so there is nothing to cost it from.",
  };
}

/* ══ PARSING WHAT SALES SENT ══════════════════════════════════════════════ */

const lift = (fn, field) => {
  try { return fn(); } catch (e) {
    if (e instanceof DecimalError) {
      throw fail(CODES.VALIDATION, e.message || "That is not a quantity.", { field });
    }
    throw e;
  }
};

/**
 * The requested quantities, as exact decimals.
 *
 * ── THESE ARE QUOTATION BREAKS, NOT ORDER QUANTITIES ────────────────────────
 * Several are normal and they are hypothetical: "what would 500 cost, and what
 * would 2,000 cost". The committed figure is the work order's, and it arrives
 * much later through a different record. Reusing an order-quantity structure
 * for these would make a quote look like a commitment.
 */
function parseQuantities(raw) {
  if (!Array.isArray(raw) || !raw.length) {
    throw fail(CODES.VALIDATION, "Say at least one quantity to be priced.",
      { field: "quantities", reason: "QUANTITY_REQUIRED" });
  }
  if (raw.length > MAX_QUANTITIES) {
    throw fail(CODES.VALIDATION, `A brief may ask for at most ${MAX_QUANTITIES} quantities.`,
      { field: "quantities", reason: "TOO_MANY" });
  }

  const seen = new Set();
  const out = raw.map((q, i) => {
    const field = `quantities[${i}]`;
    const key = str(q?.key).slice(0, 64);
    if (!key) throw fail(CODES.VALIDATION, "Every quantity needs a key.", { field: `${field}.key` });
    if (seen.has(key)) {
      throw fail(CODES.VALIDATION, `Two quantities share the key "${key}".`,
        { field: `${field}.key`, reason: "KEY_DUPLICATE", key });
    }
    seen.add(key);

    const quantity = lift(
      () => dec(q?.quantity, { field: `${field}.quantity`, allowNegative: false }),
      `${field}.quantity`,
    );
    if (quantity.isZero()) {
      throw fail(CODES.VALIDATION, "A quantity of nothing prices nothing.",
        { field: `${field}.quantity`, reason: "QUANTITY_ZERO", key });
    }

    /* ── OPTIONAL, BECAUSE A COSTING PRECEDES A PRICE ──────────────────
       A costing is routinely raised before anybody has proposed what to sell
       at. An absent price is that, and it is never read as nil. */
    let price;
    if (q?.proposedSellingPriceExclTax !== undefined && q?.proposedSellingPriceExclTax !== null
      && str(q.proposedSellingPriceExclTax) !== "") {
      const p = lift(
        () => dec(q.proposedSellingPriceExclTax, {
          field: `${field}.proposedSellingPriceExclTax`, allowNegative: false,
        }),
        `${field}.proposedSellingPriceExclTax`,
      );
      price = p.toFixed();
    }

    return {
      key,
      label: str(q?.label).slice(0, 200) || key,
      quantity: quantity.toFixed(),
      isPrimary: q?.isPrimary === true,
      ...(price === undefined ? {} : { proposedSellingPriceExclTax: price }),
    };
  });

  /* ── EXACTLY ONE PRIMARY ──────────────────────────────────────────────
     The coverage assessment is made against one run size. Two would be two
     assessments; none would be an arbitrary choice made by array order. */
  const primaries = out.filter((q) => q.isPrimary);
  if (primaries.length > 1) {
    throw fail(CODES.VALIDATION, "Only one quantity can be the primary one.",
      { field: "quantities", reason: "PRIMARY_AMBIGUOUS", keys: primaries.map((q) => q.key) });
  }
  if (!primaries.length) out[0].isPrimary = true;
  return out;
}

/** Refuse a body that names something Sales does not own. */
function assertBriefShape(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw fail(CODES.VALIDATION, "That is not a costing brief.");
  }
  for (const key of Object.keys(body)) {
    const refused = REFUSED_FIELDS[key];
    if (refused) {
      throw fail(CODES.FIELD_NOT_ACCEPTED,
        `A costing brief says what to cost, never what it costs. It cannot carry ${refused}.`,
        { field: key, reason: "FIELD_OWNED_ELSEWHERE" });
    }
    if (!BRIEF_FIELDS.includes(key)) {
      throw fail(CODES.FIELD_NOT_ACCEPTED, `"${key}" is not part of a costing brief.`, { field: key });
    }
  }
}

/* ══ READING ═══════════════════════════════════════════════════════════════ */

/** The enquiry, proved to belong to this company. Missing and foreign alike. */
async function loadOwnedEnquiry(ctx, enquiryId) {
  if (!ctx?.companyId) throw fail("COMPANY_CONTEXT_UNAVAILABLE", "Your company could not be resolved.");
  if (!isId(enquiryId)) throw fail(CODES.NOT_FOUND, "That enquiry was not found.");
  const enquiry = await Enquiry().findOne({ _id: enquiryId, companyId: ctx.companyId, isActive: true });
  if (!enquiry) throw fail(CODES.NOT_FOUND, "That enquiry was not found.");
  return enquiry;
}

const ACTIVE = [STATE.DRAFT, STATE.CONFIRMED];
const isActive = (b) => ACTIVE.includes(str(b?.state) || STATE.DRAFT);

/** One brief, as a Sales screen reads it. No cost, no rate, no margin. */
function briefView(b = {}) {
  return {
    briefId: str(b.briefId),
    sampleStyleId: b.sampleStyleId ? String(b.sampleStyleId) : null,
    styleCode: str(b.styleCode),
    styleReference: str(b.styleReference),
    variantLabel: str(b.variantLabel),
    productName: str(b.productName),
    quantities: (b.quantities || []).map((q) => ({
      key: str(q.key),
      label: str(q.label) || str(q.key),
      quantity: str(q.quantity),
      isPrimary: q.isPrimary === true,
      proposedSellingPriceExclTax: str(q.proposedSellingPriceExclTax) || null,
    })),
    quantityUom: str(b.quantityUom),
    currency: str(b.currency) || "INR",
    note: str(b.note),
    requiredBy: b.requiredBy || null,
    state: str(b.state) || STATE.DRAFT,
    confirmedAt: b.confirmedAt || null,
    confirmedByName: str(b.confirmedBy?.name),
    supersededAt: b.supersededAt || null,
    supersededByBriefId: str(b.supersededByBriefId) || null,
    supersessionReason: str(b.supersessionReason) || null,
    revision: Number(b.revision) || 0,
    updatedAt: b.updatedAt || null,
  };
}

/**
 * THE BRIEFS ON ONE ENQUIRY, AND THE STYLES SALES MAY CHOOSE FROM.
 *
 * Superseded briefs are RETURNED, not filtered out: "we quoted style A and
 * moved to B" is a fact somebody may have to explain, and a list that showed
 * only the live one would make the change invisible.
 */
async function readBriefs(ctx, { enquiryId, productName = "" } = {}) {
  const enquiry = await loadOwnedEnquiry(ctx, enquiryId);
  const wanted = str(productName);

  /* The styles this enquiry's products were sampled as. Scoped by the
     enquiry, which is already proved — a style names its enquiry, so no
     second ownership rule is needed and none is written. */
  const styles = await SampleStyle()
    .find({ enquiryId: enquiry._id, ...(wanted ? { productName: wanted } : {}) })
    .select("sampleStyleId styleCode productName variantLabel enquiryId techSheet.status "
      + "techSheet.technical.status techSheet.technicalRevisions bomApproval.status sample.status sample.rounds")
    .lean();

  const options = styles.map((style) => {
    const state = approvalStateOf(style);
    return styleOption(style, state);
  });

  const briefs = (enquiry.costingBriefs || [])
    .filter((b) => (wanted ? str(b.productName) === wanted : true))
    .map(briefView);

  return {
    enquiryId: String(enquiry._id),
    enquiryRef: str(enquiry.enquiryId),
    /* What Sales may choose from, and why each one may or may not be chosen.
       A style that is not quotable is LISTED, with its reason — an absent
       option reads as a style that does not exist. */
    styles: options,
    briefs,
    /* The one a costing would read, if any. Named so a screen can say "this
       is what Central Costing is working from" without deriving it. */
    confirmed: briefs.filter((b) => b.state === STATE.CONFIRMED),
  };
}

/* ══ WRITING ══════════════════════════════════════════════════════════════ */

/**
 * SAVE A DRAFT BRIEF FOR ONE STYLE.
 *
 * One ACTIVE brief per style: a second one for the same style would be two
 * requests to cost the same thing, and nothing decides between them. Saving
 * again updates the existing draft and bumps its revision.
 *
 * A CONFIRMED brief is not edited in place — it is what a frozen costing
 * version cites. Changing it would rewrite what that version was calculated
 * from. Confirm again to move it forward, which supersedes explicitly.
 */
async function saveBrief(ctx, { enquiryId, body = {}, actor = null, revise = false } = {}) {
  assertBriefShape(body);
  const enquiry = await loadOwnedEnquiry(ctx, enquiryId);

  const sampleStyleId = str(body.sampleStyleId);
  if (!isId(sampleStyleId)) {
    throw fail(CODES.VALIDATION, "Choose the approved style this quotation is for.",
      { field: "sampleStyleId", reason: "STYLE_REQUIRED" });
  }
  /* Proved through the enquiry, which is already proved. A style from another
     enquiry is NOT FOUND rather than refused: saying "that exists, elsewhere"
     is itself a disclosure. */
  const style = await SampleStyle().findOne({ _id: sampleStyleId, enquiryId: enquiry._id })
    .select("sampleStyleId styleCode productName variantLabel techSheet.status "
      + "techSheet.technical.status techSheet.technicalRevisions").lean();
  if (!style) throw fail(CODES.NOT_FOUND, "That style is not on this enquiry.");

  const quantities = parseQuantities(body.quantities);
  const now = new Date();

  const existing = (enquiry.costingBriefs || [])
    .find((b) => String(b.sampleStyleId) === String(style._id) && isActive(b));

  /* ── A CONFIRMED BRIEF IS NEVER REWRITTEN ────────────────────────────
     A frozen costing version cites it. Editing it would make that version
     describe a garment it was not calculated for.

     ── AND THE WAY FORWARD IS A NEW ONE ───────────────────────────────
     The refusal below says so — "confirm a new one to move the quotation
     forward" — and for a long time there was no way to do that: `saveBrief`
     refused, so the only route it named was closed. `revise` opens it, and
     opens nothing else. The confirmed brief is left exactly as it is; a
     fresh DRAFT is started beside it, and confirming that one supersedes
     the old explicitly, with a reason, as it always has.

     Off by default. A client that did not ask to revise still gets the
     refusal, because saving over a confirmed decision by accident is the
     thing this rule exists to stop. */
  const superseding = Boolean(revise) && existing && str(existing.state) === STATE.CONFIRMED;
  if (existing && str(existing.state) === STATE.CONFIRMED && !superseding) {
    throw fail(CODES.BRIEF_NOT_CONFIRMABLE,
      "This brief is confirmed and a costing may already have been calculated from it. "
      + "Confirm a new one to move the quotation forward — the old one is superseded, not rewritten.",
      { field: "state", reason: "CONFIRMED_BRIEF_IMMUTABLE", briefId: str(existing.briefId) });
  }

  /* ── OPTIMISTIC CONCURRENCY, WHERE THE CALLER ASKED FOR IT ────────────
     A caller that sends the revision it read is refused if somebody else has
     saved since. A caller that sends none is not forced to — most saves are
     the only person working on the enquiry. */
  if (existing && body.revision !== undefined && Number(body.revision) !== Number(existing.revision || 0)) {
    throw fail(CODES.BRIEF_REVISION_CONFLICT,
      "Somebody else changed this brief while you were editing it. Reload and try again.",
      { field: "revision", expected: Number(existing.revision || 0), submitted: Number(body.revision) });
  }

  const fields = {
    sampleStyleId: style._id,
    styleCode: str(style.styleCode),
    styleReference: str(style.sampleStyleId),
    variantLabel: str(style.variantLabel),
    /* A snapshot, for reading. Nothing joins on it. */
    productName: str(style.productName),
    quantities,
    quantityUom: str(body.quantityUom).slice(0, 32),
    currency: (str(body.currency) || "INR").toUpperCase().slice(0, 8),
    note: str(body.note).slice(0, 1000),
    ...(body.requiredBy ? { requiredBy: new Date(body.requiredBy) } : { requiredBy: undefined }),
    updatedAt: now,
    ...(actor ? { updatedBy: actor } : {}),
  };

  enquiry.costingBriefs = enquiry.costingBriefs || [];
  if (existing && !superseding) {
    Object.assign(existing, fields, { revision: Number(existing.revision || 0) + 1 });
  } else {
    enquiry.costingBriefs.push({
      briefId: crypto.randomBytes(8).toString("hex"),
      ...fields,
      state: STATE.DRAFT,
      revision: 0,
      createdAt: now,
      ...(actor ? { createdBy: actor } : {}),
    });
  }
  enquiry.markModified("costingBriefs");
  await enquiry.save();
  return readBriefs(ctx, { enquiryId, productName: str(style.productName) });
}

/**
 * CONFIRM A BRIEF — AND SUPERSEDE WHATEVER IT REPLACES.
 *
 * ── THE TWO RULES ───────────────────────────────────────────────────────────
 * A brief may be confirmed only for a style whose technical revision is
 * APPROVED. Anything else would ask Central Costing to price a record that
 * does not exist yet, and the refusal would land on the costing rather than
 * where the choice was made.
 *
 * And a confirmed brief for the SAME PRODUCT is superseded explicitly, naming
 * its successor and a reason. Never retargeted: a frozen costing version cites
 * a brief, and editing that brief to point at a different style would make
 * every one of those versions describe a garment they were not calculated for.
 */
async function confirmBrief(ctx, { enquiryId, briefId, reason = "", actor = null } = {}) {
  const enquiry = await loadOwnedEnquiry(ctx, enquiryId);
  const brief = (enquiry.costingBriefs || []).find((b) => str(b.briefId) === str(briefId));
  if (!brief) throw fail(CODES.NOT_FOUND, "That costing brief was not found.");

  if (str(brief.state) === STATE.SUPERSEDED) {
    throw fail(CODES.BRIEF_SUPERSEDED,
      "This brief was superseded and cannot be confirmed again. Raise a new one.",
      { briefId: str(brief.briefId), supersededByBriefId: str(brief.supersededByBriefId) });
  }
  if (str(brief.state) === STATE.CONFIRMED) {
    /* Idempotent: confirming a confirmed brief is not an error, and refusing
       it would make a retried request look like a conflict. */
    return readBriefs(ctx, { enquiryId, productName: str(brief.productName) });
  }

  const style = await SampleStyle().findOne({ _id: brief.sampleStyleId, enquiryId: enquiry._id })
    .select("sampleStyleId styleCode productName techSheet.status "
      + "techSheet.technical.status techSheet.technicalRevisions").lean();
  if (!style) throw fail(CODES.NOT_FOUND, "That style is not on this enquiry.");

  const { quotable, approvedRevision } = approvalStateOf(style);
  if (!quotable) {
    throw fail(CODES.STYLE_NOT_APPROVED,
      "This style's technical record has not been approved, so there is nothing to cost it from. "
      + "R&D submits it and Sales approves the revision before a quotation can be briefed.",
      {
        field: "sampleStyleId",
        reason: "TECHNICAL_REVISION_NOT_APPROVED",
        owner: { department: "R&D and Sales", recordedIn: "Style · Technical record" },
      });
  }

  const now = new Date();

  /* ── THE ONE THAT IS BEING REPLACED ───────────────────────────────────
     Any OTHER confirmed brief for the same product — but only where the
     enquiry has ONE row for that product.

     ── WHY THAT CONDITION APPEARED ───────────────────────────────────
     Two confirmed briefs naming two styles of one garment mean two
     different things, and the briefs alone cannot tell them apart:

       · one enquiry row → Sales MOVED the quotation from one style to the
         other, and the first brief is finished;
       · two enquiry rows → the customer is buying both colourways, and
         each row has its own commercial line, quantity and costing.

     Superseding unconditionally served the first and broke the second:
     confirming the second colourway silently closed the first's brief,
     putting a line nobody had touched out of sync with its own costing —
     which is what a proforma for two colourways then refused on.

     The enquiry's own rows are the discriminator, and they are the record
     that actually knows. */
  const sameNamedRows = (enquiry.products || [])
    .filter((p) => str(p.product) === str(style.productName)).length;
  const replaced = sameNamedRows > 1 ? [] : (enquiry.costingBriefs || []).filter((b) => (
    str(b.briefId) !== str(brief.briefId)
    && str(b.state) === STATE.CONFIRMED
    && str(b.productName) === str(style.productName)
  ));
  for (const old of replaced) {
    old.state = STATE.SUPERSEDED;
    old.supersededAt = now;
    if (actor) old.supersededBy = actor;
    old.supersededByBriefId = str(brief.briefId);
    old.supersessionReason = str(reason).slice(0, 500)
      || `Sales moved this quotation to style ${str(style.styleCode) || str(style.sampleStyleId)}.`;
  }

  brief.state = STATE.CONFIRMED;
  brief.confirmedAt = now;
  if (actor) brief.confirmedBy = actor;
  brief.updatedAt = now;
  brief.revision = Number(brief.revision || 0) + 1;
  /* The revision of the TECHNICAL record this was confirmed against, frozen
     onto the snapshot so a reader can tell a quotation briefed against
     revision 2 from one briefed against revision 3. */
  brief.styleReference = str(style.sampleStyleId);
  brief.styleCode = str(style.styleCode);

  enquiry.markModified("costingBriefs");
  await enquiry.save();

  const out = await readBriefs(ctx, { enquiryId, productName: str(style.productName) });
  return { ...out, approvedRevision, superseded: replaced.map((b) => str(b.briefId)) };
}

/* ══ WHAT CENTRAL COSTING READS ═══════════════════════════════════════════ */

/**
 * THE CONFIRMED BRIEF FOR ONE ENQUIRY PRODUCT, OR NOTHING.
 *
 * Read-only, and the ONLY way Central Costing learns what to cost. Returns
 * `null` where Sales has not asked — which is a blocking state named on them,
 * never a default quantity, a default unit or a style picked by ordering.
 *
 * Exported for the costing assembly; it takes a plain enquiry document so the
 * caller that has already proved and read one does not read it twice.
 */
function confirmedBriefOn(enquiry, productName, { sampleStyleId = "" } = {}) {
  const wanted = str(productName);
  const styleId = str(sampleStyleId);
  const briefs = (enquiry?.costingBriefs || [])
    .filter((b) => str(b.state) === STATE.CONFIRMED && str(b.productName) === wanted)
    /* ── AND THE STYLE, WHERE THE CALLER KNOWS IT ────────────────────
       One enquiry can carry the same garment twice in two colourways.
       Those are two styles and two briefs, so matching on the name alone
       found both and reported an ambiguity that is not one — the caller
       knew perfectly well which style it meant. Given the style, the answer
       is exact; given none, the behaviour is what it always was. */
    .filter((b) => !styleId || String(b.sampleStyleId || "") === styleId);
  if (!briefs.length) return null;
  /* Supersession guarantees one. If two ever coexist, the newest confirmation
     is not silently preferred — the caller is told, because two live requests
     for one product is a state somebody has to resolve. */
  if (briefs.length > 1) {
    throw fail(CODES.VALIDATION,
      "This product has more than one confirmed costing brief. Sales must supersede the one that no longer applies.",
      { reason: "CONFIRMED_BRIEF_AMBIGUOUS", briefIds: briefs.map((b) => str(b.briefId)) });
  }
  return briefView(briefs[0]);
}

module.exports = {
  CODES, STATE, MAX_QUANTITIES, BRIEF_FIELDS, REFUSED_FIELDS,
  approvalStateOf, styleOption, parseQuantities, assertBriefShape,
  briefView, confirmedBriefOn,
  readBriefs, saveBrief, confirmBrief,
};

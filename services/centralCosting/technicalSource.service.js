// services/centralCosting/technicalSource.service.js
//
// THE TECHNICAL RECORD A COSTING IS BUILT FROM.
//
// ── WHAT WAS MISSING ────────────────────────────────────────────────────────
// A costing raised against an enquiry product had to be typed from scratch,
// while the same materials and operations were already recorded — picked by
// the Merchandiser, measured by R&D, timed and priced by the sample. Somebody
// read one screen and retyped it into another, which is how a costing comes to
// disagree with the sample it is supposedly costing.
//
// ── AND WHY THIS IS AN ADAPTER, NOT A QUERY ─────────────────────────────────
// The technical records live in Sales and R&D. Costing reading them directly
// would spread knowledge of their shape — and of what their numbers MEAN —
// across every caller. The meanings are not obvious: two material lists that
// are alternatives rather than additions, an allowance that is already applied
// in one of them, an operator cost that is per piece, and a zero that means
// "nobody resolved a rate" rather than "free". They are established once here,
// against the write paths that produce them, and documented in
// docs/decisions/central-costing-technical-source-semantics.md.
//
// ── NOTHING IS INVENTED ─────────────────────────────────────────────────────
// No quantity is divided by an assumed sample size, no missing rate becomes
// zero, no missing unit becomes the item's default. Where the meaning of a
// stored number cannot be proved, the row says so and is not importable. A
// costing built on a guess is worse than one somebody had to finish by hand,
// because nobody can see which half was guessed.

"use strict";

const mongoose = require("mongoose");
const { fail } = require("../storePurchase/errors");
const isObjectId = (value) => mongoose.Types.ObjectId.isValid(String(value || ""));

/* Lazy, like the context resolver's: the Sales graph is large and a costing
   that never asks for technical data should not pay to load it. */
const sampleStyleModel = () => require("../../models/CMS_Models/Sales/SampleStyle");
const salesJourneyModel = () => require("../../models/CMS_Models/Sales/SalesJourney");
const enquiryModel = () => require("../../models/CMS_Models/Sales/Enquiry");
const rawItemModel = () => require("../../models/CMS_Models/Inventory/Products/RawItem");
const serviceModel = () => require("../../models/CMS_Models/Inventory/Services/Service");
const operationCosting = () => require("../operationCosting");
/* Lazy, and required here rather than at the top because the binding service
   requires THIS one back for its ownership proof. */
const approvedSource = () => require("./approvedTechnicalSource.service");

const CODES = Object.freeze({
  NOT_FOUND: "NOT_FOUND",
  CONTEXT_NOT_TECHNICAL: "COSTING_TECHNICAL_CONTEXT_NOT_SUPPORTED",
  SEVERAL_STYLES: "COSTING_TECHNICAL_SEVERAL_STYLES",
  READ_CONTEXT_REQUIRED: "COSTING_TECHNICAL_READ_CONTEXT_REQUIRED",
});

/* One indistinguishable refusal, whether the style is absent, another
   company's, or reachable from no proven parent. A refusal that varies with
   the answer is an oracle for which style ids are real. */
const notFound = () =>
  fail(CODES.NOT_FOUND, "No technical record was found for this costing.",
    { reason: "TECHNICAL_SOURCE_NOT_FOUND" });

const present = (v) => v !== null && v !== undefined && v !== "";
const str = (v) => (present(v) ? String(v).trim() : "");
const num = (v) => (present(v) && Number.isFinite(Number(v)) ? Number(v) : null);

/* ══════════════════════════════════════════════════════════════════════════
 * THE ONE EFFECTIVE CONSUMPTION
 * ═════════════════════════════════════════════════════════════════════════ */

const { dec } = require("./decimal");
const styleApplicability = require("../styleApplicability");

/**
 * How much of a material one finished piece actually consumes.
 *
 * ── THE TWO FACTS, AND WHY THEY ARE TWO ─────────────────────────────────────
 * `consumptionPerPiece` is what the garment CONTAINS: the net length, weight
 * or count that ends up in the product. `allowancePercent` is what the process
 * additionally CONSUMES to put it there — cutting loss, end bits, shrinkage,
 * the part of the roll that cannot be used. A company buys the second as
 * surely as it buys the first, and pays the same rate for it.
 *
 * R&D records them separately and deliberately. Folding the allowance into the
 * quantity is what the legacy path did, and the reason the flag below exists:
 * once the two are one number nobody can tell whether it has been applied, and
 * the next person to apply it doubles it.
 *
 * ── SO THIS IS THE ONLY PLACE THAT COMBINES THEM ────────────────────────────
 * Every consumer — the cost line, quotation applicability, the minimum-order
 * check, the tier the run reaches, Store's candidate list, the revalidation of
 * a sourcing decision, the frozen provenance and the displayed breakdown —
 * reads the result of this function. Two implementations would be two
 * quantities, and a Store screen offering a supplier a costing then refuses.
 *
 * ── ABSENT IS NOT ZERO, AND NEITHER IS AN ERROR ─────────────────────────────
 * `allowancePercent: null` means R&D has not said. `materialGaps` in
 * `technicalRecord.service.js` treats that as a legitimate answer that blocks
 * nothing — the field is optional and must be EXPLICIT, so a blank is a
 * deliberate blank rather than a forgotten one. Nothing is invented here: a
 * null allowance adds nothing, and the provenance says "not recorded" rather
 * than "0%", so the two stay distinguishable for ever.
 *
 * @returns {{ base: number|null, allowancePercent: number|null,
 *             alreadyIncluded: boolean, effective: number|null,
 *             effectiveExact: string|null }}
 */
function effectiveConsumption({ quantity, allowancePercent, allowanceAlreadyInQuantity }) {
  const base = num(quantity);
  const pct = allowancePercent === null || allowancePercent === undefined
    ? null : num(allowancePercent);

  if (base === null) {
    return { base: null, allowancePercent: pct, alreadyIncluded: Boolean(allowanceAlreadyInQuantity), effective: null, effectiveExact: null };
  }

  /* ── A LEGACY ROW IS ALREADY THE ANSWER ──────────────────────────────────
     What R&D typed into `sample.consumptionRawItems` was the effective
     consumed amount; the percentage beside it is what they were planning
     around, kept as information. Multiplying it in would charge the allowance
     twice — the single arithmetic error this whole area exists to prevent. */
  if (allowanceAlreadyInQuantity) {
    const exact = dec(base, { field: "consumption" });
    return {
      base, allowancePercent: pct, alreadyIncluded: true,
      effective: Number(exact.toFixed()), effectiveExact: exact.toFixed(),
    };
  }

  /* ── AND A MODERN ROW IS BASE PLUS ALLOWANCE ─────────────────────────────
     In exact decimal, never floating point: 1.4 × 1.05 is 1.47, and a costing
     that priced 1.4699999999999998 metres of fabric would be arithmetically
     defensible and impossible to reconcile against the record it cites. */
  const exact = pct === null || pct === 0
    ? dec(base, { field: "consumption" })
    : dec(base, { field: "consumption" })
      .multipliedBy(dec(100, { field: "allowance" }).plus(dec(pct, { field: "allowancePercent", allowNegative: false })))
      .dividedBy(dec(100, { field: "allowance" }));

  return {
    base,
    allowancePercent: pct,
    alreadyIncluded: false,
    effective: Number(exact.toFixed()),
    /* The exact string, so a consumer that must not lose a digit — the
       pricing pass, the applicability quantity — can use it rather than
       re-deriving it through a float. */
    effectiveExact: exact.toFixed(),
  };
}

/** Attach the canonical consumption to a material row, in one place. */
function withEffectiveConsumption(row) {
  const e = effectiveConsumption(row);
  return {
    ...row,
    /* Kept beside the base rather than replacing it: a reader has to be able
       to see 1.4 and 5% and 1.47, or they cannot check the third. */
    effectiveQuantity: e.effective,
    effectiveQuantityExact: e.effectiveExact,
    allowanceApplied: !e.alreadyIncluded && e.allowancePercent !== null && e.allowancePercent !== 0,
  };
}
const id = (v) => (v ? String(v) : null);

/* ── HOW A QUANTITY IS MEANT TO BE READ ─────────────────────────────────────
 * Nothing stores how many garments a sample round produced, so there is no
 * denominator and this module never divides. It grades the proof instead.
 *
 * ── AND WHY THE PRODUCT BOM IS NO LONGER PART OF THAT ──────────────────────
 * An earlier version graded a quantity `PER_GARMENT_CONFIRMED` when the linked
 * StockItem's BOM carried the same figure. StockItem has NO company ownership —
 * no `companyId`, no ownership stamp — so that was an unscoped `findById` on an
 * id taken from a Sales record. A stale or tampered `production.stockItemId`
 * pointing at another company's product would have let that company's BOM
 * decide whether this costing's row was importable: a leak, and a proof that
 * proves nothing.
 *
 * It is removed rather than scoped, because there is no field to scope it by,
 * and inventing one here would be a StockItem migration wearing a costing hat.
 * The remaining grades come only from the SampleStyle path, which IS provable.
 */
const BASIS = Object.freeze({
  /* The sample is approved, so the approval sync wrote these numbers onto the
     product as per-garment BOM quantities. The strongest claim available. */
  BY_APPROVAL: "PER_GARMENT_BY_APPROVAL",
  /* The Merchandiser's pick, which sampleStyles.js syncs as the per-garment
     required quantity. Planned, not measured. */
  PLANNED: "PER_GARMENT_PLANNED",
  /* Neither holds. Shown with its figures and NOT importable. */
  UNKNOWN: "NEEDS_CONFIRMATION",
});

const BASIS_LABEL = Object.freeze({
  [BASIS.BY_APPROVAL]: "Per garment — as approved on the sample",
  [BASIS.PLANNED]: "Per garment — planned by Merchandising",
  [BASIS.UNKNOWN]: "Quantity basis needs confirmation",
});

/* Where a figure came from, and therefore what it is worth.
   ENGINEERED is R&D's approved technical record — the fact's owner, signed
   off. It outranks the Merchandiser's shortlist (which no longer carries a
   consumption at all) and a single sample round's measurement. */
/* R&D's structured record — the authoritative source for consumption, unit,
   allowance, specification and SAM once Sales has approved it. */
const technicalRecord = require("./technicalRecord.service");

const EVIDENCE = Object.freeze({
  ENGINEERED: "RND_TECHNICAL_RECORD",
  PLANNED: "BOM_PLANNED",
  MEASURED: "SAMPLE_MEASURED",
});

/* Every reason a row cannot be brought into a costing, in words the person
   reading the preview can act on. */
const BLOCKER = Object.freeze({
  NO_ITEM: "This row names no item in the Item Master.",
  NO_QUANTITY: "No quantity was recorded.",
  NO_UNIT: "No unit was recorded.",
  BASIS_UNKNOWN: "Quantity basis needs confirmation.",
  NO_TIME: "No time was recorded for this operation.",
  NO_RATE: "No operator rate could be resolved for this operation.",
  /* Two blockers, deliberately separate. "No salary group" is fixed by a
     manager mapping the operation; "the code names two records" is fixed by
     reconciling the register. Reporting both as "no rate" would send the
     reader to the wrong screen. */
  NO_SALARY_GROUP: "This operation is not mapped to a salary group, so no labour rate can be derived. Map it in Store → Registered operations.",
  AMBIGUOUS_CODE: "More than one registered operation shares this code, so the salary group cannot be resolved. Reconcile the duplicate in Store → Registered operations.",
  NO_CARTON_CONVERSION: "This packaging is costed per carton and the sample does not say how many garments a carton holds. R&D records it once on the shipment, where freight reads it too — it is never assumed.",
  NO_SERVICE: "This row names no service in the Service Master.",
  /* ── EVIDENCE IS NOT AN AUTHORITY ──────────────────────────────────────
     The planned pick and the measured sample consumption are how the answer
     was reached; neither is the answer. A costing reads consumption from the
     revision Industrial Engineering confirmed, so these rows are shown with
     their own numbers and can no longer be taken. Saying so on the row is the
     point: `importable: true` on something nothing can import is a promise the
     screen cannot keep. */
  PLANNED_NOT_COSTABLE:
    "This is Merchandising's planned pick, kept as history. A costing reads how much a style uses "
    + "from the technical revision Industrial Engineering confirmed.",
  MEASURED_NOT_COSTABLE:
    "This is what one sample round consumed, kept as evidence. A costing reads how much a style "
    + "uses from the technical revision Industrial Engineering confirmed.",
  NO_CHARGE_TYPE: "This row names no configured company development charge.",
  SERVICE_INACTIVE: "That service is no longer active in the Service Master.",
});

function assertReadContext(ctx) {
  if (!ctx || !ctx.companyId) {
    throw fail(CODES.READ_CONTEXT_REQUIRED,
      "A technical-source read must name the company it is for.",
      { reason: "READ_CONTEXT_REQUIRED" });
  }
}

/* ═══ FINDING THE STYLE ══════════════════════════════════════════════════════
 *
 * An ENQUIRY_STYLE costing names an enquiry and a product NAME — the same pair
 * the legacy costing sheets are keyed by. SampleStyle is keyed within a journey
 * by { journeyId, productName, variantKey }, so one enquiry product can
 * legitimately have SEVERAL styles: sibling variants developed side by side so
 * the customer can pick. Taking the first would cost the navy sample and label
 * it the white one.
 */

/**
 * Match a parent by whichever kind of reference the style is holding.
 *
 * An ObjectId matches `_id`; anything else is a business reference and matches
 * the named field. Both are tried for an id-shaped value, because a business
 * reference is not guaranteed to be un-ObjectId-shaped forever and matching
 * the wrong one silently would read as "no such record".
 */
function refQuery(value, refField) {
  const raw = String(value);
  return isObjectId(value)
    ? { $or: [{ _id: value }, { [refField]: raw }] }
    : { [refField]: raw };
}

/**
 * Prove a style belongs to this company through a parent that carries one.
 *
 * SampleStyle has no `companyId` of its own. The Sales Journey is the spine
 * and is company-scoped, so it is the proof. A house sample has no journey at
 * all, and falls back to the enquiry — which the context resolver already
 * proved before the costing existed.
 */
async function ownershipProofFor(style, companyId) {
  const want = String(companyId);

  /* ── BOTH FORMS OF THE REFERENCE ARE ACCEPTED ───────────────────────────
     `journeyId` and `enquiryId` are declared as ObjectIds and normally hold
     one, but the same fields are also written from imports and older records
     carrying the business reference (`SJ-2026-0002`, `ENQ-2026-00014`). A
     lookup that only ever matched `_id` refuses those silently, as a record
     that does not exist. `refQuery` matches whichever kind is held. */

  if (style.journeyId) {
    const journey = await salesJourneyModel()
      .findOne(refQuery(style.journeyId, "journeyId")).select("companyId journeyId").lean();

    /* ── A JOURNEY THAT NAMES A COMPANY IS THE ANSWER, EITHER WAY ────────
       The journey is the spine. When it resolves AND carries a company, that
       company owns the style — so a journey belonging to somebody else is a
       refusal and must NOT fall through to the enquiry. Reading ownership
       off a second parent after the authoritative one said "not yours" is a
       tenant leak, not a fallback. */
    if (journey && journey.companyId) {
      if (String(journey.companyId) !== want) return null;
      return { proof: "SALES_JOURNEY", journeyRef: str(journey.journeyId) };
    }

    /* A journey that is missing, or that carries no company at all, has
       proved NOTHING — neither ownership nor foreignness. That is the one
       case worth asking the enquiry about: it used to end the search here,
       so a style whose journey was unowned was refused even when its own
       enquiry proved the very same company. A refusal has to mean "no parent
       proves this", not "the first parent I tried did not". */
  }

  if (style.enquiryId) {
    const enquiry = await enquiryModel()
      .findOne(refQuery(style.enquiryId, "enquiryId")).select("companyId enquiryId").lean();
    if (!enquiry) return null;
    if (String(enquiry.companyId || "") !== want) return null;
    return { proof: "ENQUIRY", journeyRef: "" };
  }

  /* No proven parent at all. Not returned — see `notFound`. */
  return null;
}

/** Whether the technical information on a style has been signed off, and by which gate. */
function approvalOf(style) {
  const bom = style.bomApproval || {};
  const tech = style.techSheet || {};
  const sample = style.sample || {};
  const rounds = Array.isArray(sample.rounds) ? sample.rounds : [];
  const latest = rounds.length ? rounds[rounds.length - 1] : null;
  return {
    bom: {
      status: str(bom.status) || "none",
      round: num(bom.round) ?? 0,
      requestedAt: bom.requestedAt || null,
      decidedAt: bom.decidedAt || null,
      decidedByName: str(bom.decidedByName),
      approved: str(bom.status) === "approved",
    },
    techSheet: {
      status: str(tech.status) || "pending",
      approvedAt: tech.approvedAt || null,
      approved: str(tech.status) === "approved",
    },
    sample: {
      status: str(sample.status) || "not_started",
      approvedAt: sample.approvedAt || null,
      approved: str(sample.status) === "approved",
      roundCount: rounds.length,
      latestRound: latest
        ? {
          roundNo: num(latest.roundNo),
          type: str(latest.type),
          outcome: str(latest.outcome) || "pending",
          judgedAt: latest.judgedAt || null,
        }
        : null,
    },
  };
}

/**
 * The styles this costing could be about.
 *
 * Returns EVERY match that can be proved to belong to the company, each with
 * enough on it to choose between them — style code, variant, and where its
 * technical information stands. Never one arbitrarily.
 */
async function findCandidates(ctx, { enquiryId, productName } = {}) {
  assertReadContext(ctx);
  if (!mongoose.Types.ObjectId.isValid(String(enquiryId || "")) || !str(productName)) {
    return { candidates: [] };
  }

  const styles = await sampleStyleModel()
    .find({ enquiryId, productName: str(productName) })
    .select([
      "sampleStyleId styleCode productName variantKey variantLabel variantChosen",
      "journeyId enquiryId enquiryProductId sampleType status stage",
      "bomApproval.status bomApproval.round bomApproval.requestedAt bomApproval.decidedAt bomApproval.decidedByName",
      "techSheet.status techSheet.approvedAt",
      "sample.status sample.approvedAt sample.rounds",
      "materials.rawItems sample.consumptionRawItems sample.operations",
      "production.stockItemId sourceStockItemId",
    ].join(" "))
    .lean();

  const candidates = [];
  for (const style of styles) {
    const owned = await ownershipProofFor(style, ctx.companyId);
    /* A foreign style is not listed as unavailable — it is not listed. */
    if (!owned) continue;
    const approval = approvalOf(style);
    candidates.push({
      styleId: id(style._id),
      sampleStyleId: str(style.sampleStyleId),
      styleCode: str(style.styleCode),
      productName: str(style.productName),
      variantKey: str(style.variantKey),
      variantLabel: str(style.variantLabel),
      variantChosen: style.variantChosen === true,
      sampleType: str(style.sampleType) || "journey",
      ownershipProof: owned.proof,
      journeyRef: owned.journeyRef,
      approval,
      /* What is actually on it, so the choice between siblings is informed by
         which one has technical data rather than by its code alone. */
      counts: {
        plannedMaterials: (style.materials?.rawItems || []).length,
        measuredMaterials: (style.sample?.consumptionRawItems || []).length,
        operations: (style.sample?.operations || []).length,
      },
    });
  }
  return { candidates };
}

/* ═══ READING ONE STYLE'S TECHNICAL FACTS ════════════════════════════════════ */

/** The blockers that stop a material row being imported, in order of severity. */
function materialBlockers(row) {
  const out = [];
  if (!row.rawItemId) out.push({ code: "NO_ITEM", message: BLOCKER.NO_ITEM });
  if (row.quantity === null || row.quantity <= 0) out.push({ code: "NO_QUANTITY", message: BLOCKER.NO_QUANTITY });
  if (!row.unit) out.push({ code: "NO_UNIT", message: BLOCKER.NO_UNIT });
  if (row.basis === BASIS.UNKNOWN) out.push({ code: "BASIS_UNKNOWN", message: BLOCKER.BASIS_UNKNOWN });
  return out;
}

function plannedRow(r) {
  const quantity = num(r.quantity);
  const base = {
    evidence: EVIDENCE.PLANNED,
    rawItemId: id(r.rawItemId),
    rawItemName: str(r.rawItemName),
    rawItemSku: str(r.rawItemSku),
    variantId: id(r.variantId),
    variantCombination: Array.isArray(r.variantCombination) ? r.variantCombination.map(str) : [],
    productVariantId: id(r.productVariantId),
    productVariantLabel: str(r.productVariantLabel),
    quantity,
    unit: str(r.unit),
    /* The Merchandiser's pick carries no allowance field at all, and
       sampleStyles.js syncs it with allowancePercent: 0. Null, not zero —
       "none recorded" and "recorded as none" are different claims. */
    allowancePercent: null,
    allowanceAlreadyInQuantity: false,
  };
  /* The Merchandiser's pick IS the per-garment required quantity —
     sampleStyles.js syncs it as one. Nothing else corroborates it, and
     nothing pretends to. */
  base.basis = quantity === null ? BASIS.UNKNOWN : BASIS.PLANNED;
  base.basisLabel = BASIS_LABEL[base.basis];
  base.blockers = [
    { code: "PLANNED_NOT_COSTABLE", message: BLOCKER.PLANNED_NOT_COSTABLE },
    ...materialBlockers(base),
  ];
  /* Never importable, whatever else is or is not recorded on it. */
  base.importable = false;
  /* The canonical consumption, attached where the row is built so every
     reader downstream gets the same number by construction. */
  return withEffectiveConsumption(base);
}

/**
 * A material as R&D ENGINEERED it, from the approved technical record.
 *
 * ── WHY THIS OUTRANKS BOTH OF THE OTHERS ────────────────────────────────────
 * `plannedRow` reads the Merchandiser's shortlist, which says WHICH material
 * and — correctly, now — nothing about how much. `measuredRow` reads what one
 * physical sample round consumed, which is evidence about a round rather than
 * a figure for the style. This reads the fact its owner established and Sales
 * approved: consumption per finished piece, in a stated unit, with an explicit
 * allowance and a specification.
 *
 * It is the only one of the three that carries an allowance the costing may
 * apply, because it is the only one where somebody was asked for it.
 */
function engineeredRow(r) {
  const quantity = num(r.consumptionPerPiece);
  const base = {
    evidence: EVIDENCE.ENGINEERED,
    rawItemId: id(r.rawItemId),
    rawItemName: str(r.rawItemName),
    rawItemSku: str(r.rawItemSku),
    variantId: id(r.variantId),
    variantCombination: Array.isArray(r.variantCombination) ? r.variantCombination.map(str) : [],
    productVariantId: null,
    productVariantLabel: "",
    quantity,
    unit: str(r.unit),
    /* Explicit, and NOT already inside the quantity — R&D records the two
       separately, which is exactly the distinction `measuredRow` could not
       make and had to document its way around. */
    allowancePercent: r.allowancePercent === null || r.allowancePercent === undefined
      ? null : num(r.allowancePercent),
    allowanceAlreadyInQuantity: false,
    specification: str(r.specification),
    notes: str(r.evidenceNote),
  };
  /* Approved by Sales against a named revision, which is what establishes it
     as a per-garment figure. */
  base.basis = quantity === null ? BASIS.UNKNOWN : BASIS.BY_APPROVAL;
  base.basisLabel = BASIS_LABEL[base.basis];
  base.blockers = materialBlockers(base);
  /* A material R&D sent back to Merchandising is not costable and says so —
     the fix is a re-selection, not a number. */
  if (str(r.returnedToMaterials?.reason)) {
    base.blockers = [{
      code: "NO_ITEM",
      message: `${base.rawItemName || "This material"} was sent back to Materials: ${str(r.returnedToMaterials.reason)}`,
    }];
  }
  base.importable = base.blockers.length === 0;
  /* The canonical consumption, attached where the row is built so every
     reader downstream gets the same number by construction. */
  return withEffectiveConsumption(base);
}

function measuredRow(r, { sampleApproved }) {
  const quantity = num(r.quantity);
  const base = {
    evidence: EVIDENCE.MEASURED,
    rawItemId: id(r.rawItemId),
    rawItemName: str(r.rawItemName),
    rawItemSku: "",
    variantId: id(r.variantId),
    variantCombination: Array.isArray(r.variantCombination) ? r.variantCombination.map(str) : [],
    productVariantId: null,
    productVariantLabel: "",
    quantity,
    unit: str(r.unit),
    /* ── THE ALLOWANCE IS ALREADY IN THE QUANTITY ──────────────────────────
       sampleStyles.js:1508 is explicit: what R&D typed is the EFFECTIVE
       consumed amount, which is why the approval sync passes it with
       allowancePercent: 0. Carried through as information — what R&D was
       planning around — and never multiplied in again. The schema comment on
       the field says the opposite; the write path is what ran. */
    allowancePercent: num(r.allowancePercent),
    allowanceAlreadyInQuantity: true,
    notes: str(r.notes),
  };
  if (quantity === null) base.basis = BASIS.UNKNOWN;
  /* The ONLY thing that establishes what a measured figure was measured
     against: Sales approving the sample, which is what runs the sync that
     writes it onto the product as a per-garment BOM quantity. */
  else if (sampleApproved) base.basis = BASIS.BY_APPROVAL;
  /* Measured, but nothing has established what it was measured against — a
     round may have made three garments. Shown, not divided, not importable. */
  else base.basis = BASIS.UNKNOWN;
  base.basisLabel = BASIS_LABEL[base.basis];
  base.blockers = [
    { code: "MEASURED_NOT_COSTABLE", message: BLOCKER.MEASURED_NOT_COSTABLE },
    ...materialBlockers(base),
  ];
  /* Never importable, whatever else is or is not recorded on it. */
  base.importable = false;
  /* The canonical consumption, attached where the row is built so every
     reader downstream gets the same number by construction. */
  return withEffectiveConsumption(base);
}

/**
 * One operation, and whether its cost means anything.
 *
 * `operatorCost` is rupees for this operation on ONE piece —
 * salary / 12,480 minutes x SAM (services/operationCosting.js). Importable
 * as a PER_UNIT line exactly as it stands.
 *
 * The trap is the zero. `costOperations` returns 0 when it could resolve no
 * salary basis, and 0 is also a real value. A zero with no salary and no
 * department is MISSING, and reporting it as a free operation would put a
 * garment's stitching in a costing at nothing.
 */
function operationRow(o) {
  const minutes = num(o.minutes) ?? 0;
  const seconds = num(o.seconds) ?? 0;
  const totalSeconds = num(o.totalSeconds);
  const samMinutes = minutes + seconds / 60;
  const operatorSalary = num(o.operatorSalary) ?? 0;
  const operatorCost = num(o.operatorCost) ?? 0;

  const hasTime = samMinutes > 0 || (totalSeconds !== null && totalSeconds > 0);
  const rateResolved = operatorSalary > 0 || Boolean(str(o.salaryDept) || str(o.salaryDesig));
  const hasCost = operatorCost > 0;

  /* ── WHAT THE CANONICAL CALCULATION ACTUALLY NEEDS ────────────────────
     A SAM and a readable salary. `operatorCost` is the SAMPLE's own
     `salary / 12,480 x SAM`, generated by older code — and requiring it here
     made an operation un-importable purely because that legacy field was
     absent, even when the SAM and the salary the company policy needs were
     both sitting on the record.

     A salary that resolved to nothing is still a refusal: the payroll lookup
     found no readable figure, and a garment's stitching costed at zero is
     worse than one nobody costed. */
  const hasSalary = operatorSalary > 0;

  const blockers = [];
  if (!hasTime) blockers.push({ code: "NO_TIME", message: BLOCKER.NO_TIME });

  /* ── AMBIGUITY IS NAMED BEFORE ANYTHING ELSE ──────────────────────────
     `costOperations` stamps this when a row's code matched more than one
     registered operation and it therefore resolved to none. It is reported
     WITH the code, because "reconcile the duplicate" is unactionable without
     knowing which one. */
  const ambiguousCode = str(o.ambiguousOperationCode);
  if (ambiguousCode) {
    blockers.push({
      code: "AMBIGUOUS_CODE",
      message: `${ambiguousCode}: ${BLOCKER.AMBIGUOUS_CODE}`,
      operationCode: ambiguousCode,
    });
  } else if (!hasSalary && !hasCost && !rateResolved) {
    /* Nothing priced it AND no salary group is mapped — the mapping is the
       fix, so that is what it says. */
    blockers.push({ code: "NO_SALARY_GROUP", message: BLOCKER.NO_SALARY_GROUP });
  } else if (!hasSalary && !hasCost) {
    blockers.push({ code: "NO_RATE", message: BLOCKER.NO_RATE });
  }

  return {
    operationCode: str(o.operationCode),
    /* Stable identity, carried through so a later read never has to match on
       a code that may be ambiguous. */
    operationId: o.operationId ? String(o.operationId) : null,
    name: str(o.type),
    machine: str(o.machine),
    machineType: str(o.machineType),
    minutes,
    seconds,
    totalSeconds,
    samMinutes: Number(samMinutes.toFixed(6)),
    salaryDept: str(o.salaryDept),
    salaryDesig: str(o.salaryDesig),
    operatorSalary: operatorSalary > 0 ? operatorSalary : null,
    /* Null, never 0, when nothing priced it. */
    operatorCost: hasCost ? operatorCost : null,
    rateBasis: rateResolved
      ? `Average net salary for ${str(o.salaryDept) || "—"} / ${str(o.salaryDesig) || "—"}, over 26 days x 8 hours`
      : null,
    costBasis: "PER_GARMENT",
    blockers,
    importable: blockers.length === 0,
  };
}

/* ── WHAT NOBODY RECORDED, AND WHY THAT LIST IS GONE ───────────────────────
 *
 * `UNRESOLVED` was four named groups — outside services, embellishment,
 * packaging, development — returned on every style so a costing could be
 * honest about the families no record answered. It was right when it was
 * written: none of them had a source, and an empty section that totals to
 * zero reads as "none needed" rather than "nobody said".
 *
 * Three of the four have sources now. `sample.packagingRequirements` and the
 * two halves of `sample.serviceRequirements` are real records with real
 * owners, and `costCoverage` already assesses each of them as a family — from
 * the assembled lines, and from the owning department's explicit decision
 * when there are none. So the group list had become a SECOND checklist over
 * the same three questions, and it could only ever be closed the one way this
 * task retires: by somebody in Costing declaring the group not applicable.
 *
 * The fourth, `embellishment`, was printing, embroidery, washing and testing —
 * outside processes, which is what the `services` group already is. It had no
 * record of its own, no department, and no family; it could be answered only
 * by a Costing-side decision, and there is now no such thing.
 *
 * Frozen versions keep their `not-applicable:<group>` source references and go
 * on reading exactly as they did. What is gone is the ability to make another.
 */

/* ── WHAT THE GARMENT IS PACKED IN ────────────────────────────────────────
 * R&D's row, and nothing about what it costs. `SampleStyle` carries no rate
 * for packaging on purpose: the Store quotation register is dated and this
 * record is not, and two prices for one poly bag is one price too many.
 *
 * `basis` is the fact a material row does not need. A poly bag is per garment
 * and scales; a master carton is bought for the run and dilutes across it.
 * Guessing it from the item would be a hundredfold error on a 500-piece order.
 */
/**
 * @param {object} r  one `sample.packagingRequirements` row
 * @param {object} [opts]
 * @param {number|null} [opts.garmentsPerCarton] from `sample.shipment` — the
 *   one place this style states it, shared with the freight family
 */
function packagingRow(r, { garmentsPerCarton = null } = {}) {
  const quantity = num(r.quantity);
  /* Folded onto the row so the blocker and the assembly both read one shape,
     while the FACT still has exactly one home. */
  r = r.basis === "PER_CARTON" ? { ...r, garmentsPerCarton } : r;
  const base = {
    /* The ROW's identity where it has one — two legitimate packaging rows
       naming the same item and variant are two rows, not one. A row stored
       before `rowId` existed falls back to what it names, which is what its
       key already was. */
    requirementKey: str(r.rowId)
      ? `pkg:${str(r.rowId)}`
      : `pkg:${id(r.rawItemId) || "?"}::${id(r.variantId) || ""}`,
    rawItemId: id(r.rawItemId),
    rawItemName: str(r.rawItemName),
    rawItemSku: str(r.rawItemSku),
    variantId: id(r.variantId),
    variantLabel: str(r.variantLabel),
    specification: str(r.specification),
    quantity,
    unit: str(r.unit),
    basis: ["PER_CARTON", "FIXED_PER_RUN"].includes(r.basis) ? r.basis : "PER_GARMENT",
    /* Read from the STYLE's shipment record, which is where the count
       already lives and where freight reads it — never from the row, which
       would let one style hold two answers. Passed in by the caller because
       a row does not know its own style. */
    garmentsPerCarton: r.basis === "PER_CARTON" ? num(r.garmentsPerCarton) : null,
    /* ── ABSENT IS PLANNED, NEVER MEASURED ──────────────────────────────────
       "Measured on the sample" is a claim that the physical sample
       demonstrated this figure, and it is what lets a costing treat the row
       as verified. A row written before the field existed, or by a caller
       that omitted it, has demonstrated nothing — so the safe reading is the
       weaker one, and the difference stays visible all the way to the frozen
       version. */
    evidence: r.evidence === "SAMPLE_MEASURED" ? EVIDENCE.MEASURED : EVIDENCE.PLANNED,
    included: r.included !== false,
    excludedReason: str(r.excludedReason),
    notes: str(r.notes),
    itemInRegister: null,
    registeredUnit: "",
  };
  base.blockers = packagingBlockers(base);
  base.importable = base.blockers.length === 0;
  return base;
}

/** The blockers that stop a packaging row being costed. */
function packagingBlockers(row) {
  const out = [];
  if (!row.rawItemId) out.push({ code: "NO_ITEM", message: BLOCKER.NO_ITEM });
  /* ── MISSING IS NOT ZERO ────────────────────────────────────────────────
     A packaging row R&D left unfinished is an unfinished technical record. A
     zero would cost the garment as though it shipped unpacked, and nothing on
     the version would say a row had been dropped. */
  if (row.quantity === null || row.quantity <= 0) out.push({ code: "NO_QUANTITY", message: BLOCKER.NO_QUANTITY });
  if (!row.unit) out.push({ code: "NO_UNIT", message: BLOCKER.NO_UNIT });
  /* ── A CARTON BASIS WITHOUT ITS CONVERSION IS AMBIGUOUS ────────────────
     "One carton per garment" is a real answer and "one per twenty-five" is a
     real answer, and nothing in the row distinguishes them without this.
     Refused rather than assumed: taking the absence as 1 produces the
     costliest possible reading, and produces it silently. */
  if (row.basis === "PER_CARTON"
    && (row.garmentsPerCarton === null || !(row.garmentsPerCarton > 0))) {
    out.push({ code: "NO_CARTON_CONVERSION", message: BLOCKER.NO_CARTON_CONVERSION });
  }
  return out;
}

/* ── WHAT IS SENT OUTSIDE ─────────────────────────────────────────────────
 * The requirement, never the charge. `Service.defaultRate` is planning
 * guidance by its own schema's account and is not read anywhere in this
 * module — the rate comes from a dated service quotation or the line is
 * blocked.
 */
function serviceRow(r) {
  const quantity = num(r.quantity);
  /* ── RECURRING WORK, OR ONE-TIME SETUP ──────────────────────────────────
     Anything not deliberately marked as tooling is an outside PROCESS, which
     is what every row written before the field existed is. A tooling row is
     one-time by definition, so its basis is forced rather than read: a screen
     charge stored as per-garment would be multiplied by the run. */
  const development = r.purpose === "DEVELOPMENT_TOOLING";
  /* ── ONE SOURCE, AND THE IDENTITY THAT GOES WITH IT ─────────────────────
     Work the company does itself is identified by the CHARGE it is costed
     from; work bought outside is identified by the service. A row that
     somehow carries both — a stale draft, a crafted payload — is not costed
     twice and does not silently change identity: the declared source decides
     which half is read, and the other is dropped here rather than left lying
     around for something downstream to pick up. */
  const internal = development && r.developmentSource === "COMPANY_POLICY";
  /* ── THE ROW'S OWN IDENTITY, NOT WHAT IT NAMES ─────────────────────────
     Keyed by the service or the charge alone, two legitimate requirements
     using the same one are a single line: screens for the body and screens
     for the sleeve collide, and one of them is either merged away or counted
     twice. So the key is the ROW's, minted on the style and stable across
     edits, with what it names kept alongside for readability.

     A row stored before `rowId` existed has none. It falls back to what it
     names — which is exactly what it used to be, so an old style's costing
     does not change its keys underneath it. */
  const identity = str(r.rowId)
    || (internal ? str(r.developmentChargeKey) : id(r.serviceId)) || "?";
  const base = {
    rowId: str(r.rowId),
    /* Distinct prefixes, because the two are different LINES — a style may
       legitimately require both a wash and the screens to print with. */
    requirementKey: `${development ? "dev" : "svc"}:${identity}`,
    purpose: development ? "DEVELOPMENT_TOOLING" : "OUTSIDE_PROCESS",
    /* Where the money comes from. Absent on an outside process, which has
       only one source. */
    developmentSource: development
      ? (internal ? "COMPANY_POLICY" : "SUPPLIER_QUOTATION")
      : null,
    developmentChargeKey: development ? str(r.developmentChargeKey) : "",
    serviceId: internal ? "" : id(r.serviceId),
    serviceCode: str(r.serviceCode),
    serviceName: str(r.serviceName),
    specification: str(r.specification),
    quantity,
    billingUnit: str(r.billingUnit),
    basis: development ? "FIXED_PER_RUN" : (r.basis === "FIXED_PER_RUN" ? "FIXED_PER_RUN" : "PER_GARMENT"),
    /* Which desk stated it. A finishing process is often Production's call
       and a costing that cannot say has nobody to ask when it is wrong. */
    owner: r.owner === "PRODUCTION" ? "PRODUCTION" : "RND",
    evidence: r.evidence === "SAMPLE_MEASURED" ? EVIDENCE.MEASURED : EVIDENCE.PLANNED,
    included: r.included !== false,
    excludedReason: str(r.excludedReason),
    notes: str(r.notes),
    serviceInRegister: null,
    registeredBillingUnit: "",
    serviceActive: null,
  };
  base.blockers = serviceBlockers(base);
  base.importable = base.blockers.length === 0;
  return base;
}

/** The blockers that stop a required service being costed. */
function serviceBlockers(row) {
  const out = [];
  /* ── AN INTERNAL CHARGE NAMES NO SERVICE ────────────────────────────────
     The company does the work itself; there is no supplier and no Service
     master row to point at. What it must name is the CONFIGURED CHARGE, and
     it needs no billing unit either — a flat charge for the run is not billed
     per anything. */
  if (row.purpose === "DEVELOPMENT_TOOLING" && row.developmentSource === "COMPANY_POLICY") {
    if (!row.developmentChargeKey) {
      out.push({ code: "NO_CHARGE_TYPE", message: BLOCKER.NO_CHARGE_TYPE });
    }
    return out;
  }
  if (!row.serviceId) out.push({ code: "NO_SERVICE", message: BLOCKER.NO_SERVICE });
  if (row.quantity === null || row.quantity <= 0) out.push({ code: "NO_QUANTITY", message: BLOCKER.NO_QUANTITY });
  if (!row.billingUnit) out.push({ code: "NO_UNIT", message: BLOCKER.NO_UNIT });
  return out;
}

/**
 * Everything one style's technical record says, as plain facts./**
 * Everything one style's technical record says, as plain facts.
 *
 * Plain objects throughout — never a Mongoose document. A caller that could
 * `.save()` what it read could write the Sales record from a costing preview,
 * and a document handed across a domain boundary is how that starts.
 */
async function readStyleFacts(ctx, styleId) {
  assertReadContext(ctx);
  if (!mongoose.Types.ObjectId.isValid(String(styleId || ""))) throw notFound();

  const style = await sampleStyleModel().findById(styleId).lean();
  if (!style) throw notFound();

  const owned = await ownershipProofFor(style, ctx.companyId);
  if (!owned) throw notFound();

  const approval = approvalOf(style);

  /* The product this style was developed as, carried for identity only. It is
     NOT read: StockItem has no company ownership, so an id taken from a Sales
     record cannot be fetched safely, and nothing here depends on it. */
  const stockItemId = style.production?.stockItemId || style.sourceStockItemId || null;

  /* ── R&D'S APPROVED RECORD IS THE SOURCE ───────────────────────────────
     Read from the FROZEN revision Sales approved, not from the live editable
     record — R&D may already be working on the next one, and a costing must
     read what was signed off rather than what is being drafted.

     The other two lists are still returned. They are the history of how the
     answer was reached: what Merchandising selected, and what one sample
     round actually consumed. Only this one is costable. */
  /* ── THE ONE AUTHORITATIVE READ ────────────────────────────────────────
     `bindFor` proves company, style, Merchandising's approved selection, the
     IE-approved bulletin version the file points at, and that the version
     confirms the revision R&D currently stands behind. It returns the frozen
     snapshot IE reviewed, or a NAMED state with the department that owns it.

     Nothing below reads `style.techSheet` for a costable figure any more. */
  const binding = await approvedSource().bindFor(ctx, { styleId });
  const confirmed = binding.bound ? binding.technical : null;

  /* ── COSTABLE MATERIALS COME FROM THE CONFIRMED SNAPSHOT, OR NOWHERE ────
     `null`, not `[]`. An empty list is a claim — "this style uses no
     materials" — and no department has made it. A consumer that treats an
     unconfirmed style as a style with nothing to cost would publish a floor
     price built on nothing. */
  const engineered = confirmed
    ? (confirmed.materials || []).map(engineeredRow)
    : null;

  /* ── AND THESE TWO ARE HISTORY, NOT SOURCES ────────────────────────────
     `planned` is what Merchandising selected and `measured` is what one
     sample round consumed. Both are shown so a reader can see how the answer
     was reached; neither is importable, and `mergeMaterial` costs only the
     engineered side. They are read from the live style deliberately — they
     are evidence ABOUT the record, not values IN it. */
  const planned = (style.materials?.rawItems || []).map(plannedRow);
  const measured = (style.sample?.consumptionRawItems || [])
    .map((r) => measuredRow(r, { sampleApproved: approval.sample.approved }));
  /* Operation mappings live in the registered Operation master and can be
     corrected after a sample was submitted or approved. Re-resolve them on
     every costing read so the technical source reflects the current mapping
     and payroll basis. The central costing labour engine still owns the final
     policy-derived rate; this enrichment supplies facts, not the answer. */
  /* ── OPERATIONS AND SAM: THE APPROVED IE BULLETIN, AND NOTHING ELSE ────
     This used to read R&D's approved operations and, where that list was
     empty, FALL BACK to `style.sample.operations` — the route one sample run
     happened to use, which nobody engineered and nobody approved. A style
     whose approved revision carried no route was therefore costed from a
     sample.

     The route and its times are IE's own authored content now: rows two
     people signed, each carrying an APPROVED method study's standard time.
     There is no fallback, and `null` means the question is unanswered rather
     than answered with nothing. */
  /* ── IE GIVES THE ROUTE AND THE TIME; PRODUCTION GIVES THE RATE ────────
     The two are different authorities and always were. A bulletin row carries
     the operation, its revision and the APPROVED standard time — it does not
     carry a salary basis, because what an operator is paid is Production's
     record, resolved from the registered Operation master.

     Dropping this enrichment when the route moved to IE left every operation
     with no resolvable rate, so every costing blocked on
     `operation:...  is not mapped to a salary group` — a Production gap
     reported against a route IE had just approved. */
  const ieOperations = confirmed ? confirmed.operations : null;
  const resolvedIeOperations = ieOperations
    ? await operationCosting().costOperations(ieOperations.map((o) => ({
        type: o.operationName || o.operationCode,
        operationCode: o.operationCode,
        machineType: o.machineType,
        minutes: o.standardTimeMinutes === null ? null : Math.floor(o.standardTimeMinutes),
        seconds: o.standardTimeMinutes === null
          ? null : Math.round((o.standardTimeMinutes % 1) * 60),
        totalSeconds: o.standardTimeMinutes === null
          ? null : Math.round(o.standardTimeMinutes * 60),
      })))
    : null;

  const operations = confirmed
    ? confirmed.operations.map((o, i) => operationRow({
        type: o.operationName || o.operationCode,
        operationCode: o.operationCode,
        machineType: o.machineType,
        /* IE's approved standard time, in minutes. Converted to the seconds
           the row shape carries WITHOUT inventing a value: null stays null. */
        minutes: o.standardTimeMinutes === null ? null : Math.floor(o.standardTimeMinutes),
        seconds: o.standardTimeMinutes === null
          ? null : Math.round((o.standardTimeMinutes % 1) * 60),
        totalSeconds: o.standardTimeMinutes === null
          ? null : Math.round(o.standardTimeMinutes * 60),
        ieOperationId: o.ieOperationId,
        ieOperationRevision: o.ieOperationRevision,
        methodStudyId: o.methodStudyId,
        standardTimeMinutes: o.standardTimeMinutes,
        /* Production's own facts, resolved from the registered master as it
           stands NOW. A zero salary with no department and no designation is
           MISSING, not free — `operationRow` reports it as a blocker and the
           labour engine derives nothing from it. */
        operationId: resolvedIeOperations?.[i]?.operationId || null,
        salaryDept: resolvedIeOperations?.[i]?.salaryDept,
        salaryDesig: resolvedIeOperations?.[i]?.salaryDesig,
        operatorSalary: resolvedIeOperations?.[i]?.operatorSalary,
        ambiguousOperationCode: str(resolvedIeOperations?.[i]?.ambiguousOperationCode),
      }))
    : null;

  /* ── PACKAGING AND SERVICES: THE CONFIRMED SNAPSHOT ONLY ───────────────
     These read `style.sample.packagingRequirements` and
     `style.sample.serviceRequirements` live. R&D could therefore add a
     packaging line and have it priced with nobody confirming it was
     manufacturable or that its quantity was right.

     Excluded rows are kept in the RECORD and dropped from the COSTING: "we
     considered a hang tag and decided against it" is a fact worth having, and
     it is not a cost. */
  /* ── PACKAGING COMES FROM MERCHANDISING, NOT FROM THE IE SNAPSHOT ──────
     `confirmed.packaging` was read off the frozen technical snapshot, which
     has never carried a packaging key. The approved packaging identity and the
     buyer-facing specification are Merchandising's versioned record, and how
     many garments a carton holds is its approved pack configuration — so both
     arrive through `binding.packagingSource`, with provenance of their own. */
  const packagingSource = binding?.packagingSource || null;
  const packaging = Array.isArray(packagingSource?.rows)
    ? packagingSource.rows.map((r) => packagingRow(r, {
        garmentsPerCarton: binding?.packingFacts?.garmentsPerCarton ?? null,
      })).filter((r) => r.included)
    : null;

  /* ── OUTSIDE SERVICES AND DEVELOPMENT/TOOLING ──────────────────────────
     Both families live in the frozen requirements now, under their own family
     names, and `serviceRow` tells them apart by `purpose` exactly as it did
     when they arrived as one list. Kept as one costing pass over both so a
     style requiring a wash AND the screens to print with still produces two
     lines rather than one of them being filtered away. */
  const frozenServiceRows = (confirmed?.services || confirmed?.development)
    ? [...(confirmed.services || []), ...(confirmed.development || [])]
    : null;
  const services = frozenServiceRows
    ? frozenServiceRows.map(serviceRow).filter((r) => r.included)
    : null;

  /* ── THE ITEM MASTER READ IS COMPANY-SCOPED ────────────────────────────
     SKU, unit and variant label are what a costing line needs and the sample
     rows do not carry, so they are resolved from the Item Master — for
     identity only, and never as a substitute for something nobody recorded.

     Scoped by `companyId`, which RawItem carries. The ids come from a Sales
     record that itself has no company field, so a stale or tampered
     `rawItemId` can name ANY item in the deployment. Unscoped, this endpoint
     would read another company's item name, SKU, unit and variant colours
     back to whoever could open a costing — a lookup oracle dressed as a BOM.
     Out of scope means unresolved, and unresolved means unimportable. */
  /* Packaging joins the same read: it names items in the same company-scoped
     master, and a second query for the same question would be a second place
     to forget the company clause. */
  const wantedIds = [...new Set(
    [...planned, ...measured, ...(packaging || [])].map((r) => r.rawItemId).filter(Boolean),
  )];
  const itemsById = new Map();
  if (wantedIds.length) {
    const docs = await rawItemModel()
      .find({ companyId: ctx.companyId, _id: { $in: wantedIds } })
      /* ── `combination`, NOT `variantCombination` ───────────────────────
         `RawItem.variants[]` calls it `combination`; `variantCombination`
         lives on the stock-movement subdocument. Projecting the wrong one
         returned every variant as `{_id}` and nothing else, so `variantLabel`
         was silently blank on every variant material a costing ever showed —
         a missing fact that looked like a variant nobody had named. */
      .select("name sku unit customUnit variants._id variants.combination variants.sku").lean();
    for (const d of docs) itemsById.set(String(d._id), d);
  }
  for (const r of [...planned, ...measured, ...(packaging || [])]) {
    const master = r.rawItemId ? itemsById.get(r.rawItemId) : null;
    if (!master) {
      /* Named an item this company's register does not have — withdrawn, or
         belonging to somebody else. The two are deliberately the same answer:
         saying which would tell the caller that an item they cannot see
         exists. The row keeps only the name the SAMPLE recorded, which is
         this company's own data, and is not importable. */
      if (r.rawItemId) {
        r.itemInRegister = false;
        /* Blanked because these come from the REGISTER, which said nothing.
           `rawItemName` and `rawItemSku` stay: those were recorded on the
           sample, which is this company's own record. */
        r.registeredUnit = "";
        r.variantLabel = "";
        r.blockers = [{ code: "NO_ITEM", message: BLOCKER.NO_ITEM }, ...r.blockers];
        r.importable = false;
      }
      continue;
    }
    r.itemInRegister = true;
    r.rawItemName = r.rawItemName || str(master.name);
    r.rawItemSku = r.rawItemSku || str(master.sku);
    /* The register's own unit, shown as CONTEXT beside a missing unit — never
       filled in as though it had been recorded. */
    r.registeredUnit = str(master.customUnit || master.unit);
    if (r.variantId) {
      const v = (master.variants || []).find((x) => String(x._id) === r.variantId);
      r.variantLabel = v && Array.isArray(v.combination)
        ? v.combination.join(" / ") : (v?.sku || "");
    }
  }

  /* ── AND THE SERVICE MASTER READ, ON THE SAME TERMS ────────────────────
     Company-scoped for the same reason: the ids come from a Sales record that
     carries no company field of its own, so a stale or tampered `serviceId`
     could otherwise name ANY service in the deployment and read its name and
     code back to whoever can open a costing.

     `defaultRate` is not in the projection. It is planning guidance by the
     master's own account, and a field a costing cannot reach is a field a
     costing cannot accidentally use. */
  /* Internal charges name no service, so there is nothing to resolve for
     them — asking would be asking about an empty id. */
  const wantedServiceIds = [...new Set(
    (services || []).filter((r) => r.developmentSource !== "COMPANY_POLICY")
      .map((r) => r.serviceId).filter(Boolean),
  )];
  if (wantedServiceIds.length) {
    const docs = await serviceModel()
      .find({ companyId: ctx.companyId, _id: { $in: wantedServiceIds } })
      .select("serviceCode name billingUnit sacCode status").lean();
    const byId = new Map(docs.map((d) => [String(d._id), d]));
    for (const r of (services || [])) {
      if (r.developmentSource === "COMPANY_POLICY") continue;
      const master = r.serviceId ? byId.get(r.serviceId) : null;
      if (!master) {
        /* Not this company's, or withdrawn. Deliberately the same answer:
           saying which would confirm a service the caller cannot see exists. */
        if (r.serviceId) {
          r.serviceInRegister = false;
          r.blockers = [{ code: "NO_SERVICE", message: BLOCKER.NO_SERVICE }, ...r.blockers];
          r.importable = false;
        }
        continue;
      }
      r.serviceInRegister = true;
      r.serviceCode = r.serviceCode || str(master.serviceCode);
      r.serviceName = r.serviceName || str(master.name);
      /* The master's own unit, shown as CONTEXT beside a missing one — never
         filled in as though R&D had recorded it. */
      r.registeredBillingUnit = str(master.billingUnit);
      r.sacCode = str(master.sacCode);
      r.serviceActive = String(master.status || "").toUpperCase() === "ACTIVE";
      if (!r.serviceActive) {
        r.blockers = [...r.blockers, { code: "SERVICE_INACTIVE", message: BLOCKER.SERVICE_INACTIVE }];
        r.importable = false;
      }
    }
  }

  return {
    style: {
      styleId: id(style._id),
      sampleStyleId: str(style.sampleStyleId),
      styleCode: str(style.styleCode),
      productName: str(style.productName),
      variantKey: str(style.variantKey),
      variantLabel: str(style.variantLabel),
      sampleType: str(style.sampleType) || "journey",
      journeyId: id(style.journeyId),
      enquiryId: id(style.enquiryId),
      enquiryProductId: id(style.enquiryProductId),
      stockItemId: id(stockItemId),
      ownershipProof: owned.proof,
      journeyRef: owned.journeyRef,
    },
    approval,
    /* ── THE R&D RECORD, AND WHETHER IT IS USABLE ──────────────────────
       Named on the facts so a costing screen can say "R&D has not submitted
       a technical record for this style" rather than reporting an absence of
       materials it cannot explain. */
    /* ── WHAT R&D'S OWN RECORD SAYS, FOR CONTEXT ONLY ─────────────────
       Kept so a screen can explain an absence, and deliberately no longer the
       thing a costing reads. `usable` now means "IE has confirmed it", not
       "R&D approved it" — those were the same sentence and are not. */
    technicalRecord: {
      status: style.techSheet?.technical?.status || "not_started",
      currentRevision: style.techSheet?.technical?.revision || 0,
      /* Which revision IE CONFIRMED — not which one R&D last approved. Those
         were the same sentence while costing read R&D directly, and the whole
         point of the split is that they are not. Null until a confirmation
         exists, and never a number standing in for one. */
      approvedRevision: confirmed?.technicalRevision ?? null,
      approvedAt: confirmed?.approvedAt || null,
      /* Only a CONFIRMED revision is costable, and the owner of the wait is
         whichever desk the binding named — R&D only while the revision has
         not yet entered the IE chain. */
      usable: binding.bound,
      blocker: binding.bound ? null : {
        owner: binding.owner?.department || "Industrial Engineering",
        ownerSlug: binding.owner?.departmentSlug || "ie",
        state: binding.state,
        message: binding.message,
      },
    },

    /* ── THE COMPLETE SOURCE PROVENANCE THIS READ USED ────────────────
       Frozen with the version, so a costing can say exactly which approvals
       produced it — and so `sourceFingerprint` can detect any of them being
       replaced. Identities only: no consumption, no rate, no SAM. */
    approvedSource: binding.bound
      ? {
          state: binding.state,
          bound: true,
          technical: {
            ieStyleFileId: confirmed.ieStyleFileId,
            bulletinVersionId: confirmed.bulletinVersionId,
            bulletinVersionNo: confirmed.bulletinVersionNo,
            technicalRevision: confirmed.technicalRevision,
            technicalRevisionKey: confirmed.technicalRevisionKey,
            approvedAt: confirmed.approvedAt,
            approvedByName: confirmed.approvedByName,
            garmentSamMinutes: confirmed.garmentSamMinutes,
            operationCount: confirmed.operationCount,
          },
          selection: binding.selection,
          /* ── PUBLISHED SO THE FREEZE CAN NAME THEM SEPARATELY ─────────
             Provenance only: which approved packaging revision, and which
             approved weighing and pack-out, this estimate was built on. The
             rows themselves are already published as costing lines, and the
             fingerprint needs the identities — so what travels here is enough
             to COMPARE and not a second copy of the facts. */
          packagingSource: {
            form: binding.packagingSource?.form || null,
            state: binding.packagingSource?.state || null,
            provenance: binding.packagingSource?.provenance || null,
            unapproved: binding.packagingSource?.unapproved || [],
          },
          packingFacts: {
            packedWeightGrams: binding.packingFacts?.packedWeightGrams ?? null,
            garmentsPerCarton: binding.packingFacts?.garmentsPerCarton ?? null,
            provenance: binding.packingFacts?.provenance || null,
            gaps: binding.packingFacts?.gaps || [],
          },
        }
      : {
          state: binding.state,
          bound: false,
          owner: binding.owner,
          message: binding.message,
          technical: null,
          selection: binding.selection || null,
          packagingSource: null,
          packingFacts: null,
        },
    engineered,
    planned,
    measured,
    operations,
    packaging,
    services,
    /* ── AND WHETHER THREE OF THESE FAMILIES APPLY AT ALL ─────────────
       The narrow projection of the three department-owned decisions. A state,
       a reason somebody wrote, and their signature — never the stored
       sub-document, so a consumer cannot learn where on the style it lives
       and start writing there.

       Published from the read that already has the document: a second query
       for the same style would be a second place to forget the ownership
       proof this one has already made. */
    /* ── WHAT THE FINISHED GARMENT SHIPS AS ───────────────────────────
       Two facts, measured on the sample, that decide the freight line: a
       per-kilogram rate needs the packed weight and a per-carton one needs
       the capacity. Published because they MOVE the estimate, so a change to
       either has to be detectable — see `sourceFingerprint.service`. */
    /* ── SHIPMENT: TWO FACTS, TWO OWNERS, NEITHER IE'S ────────────────
       This read `confirmed.shipment` off the frozen technical snapshot, a key
       that snapshot has never carried — so a real style's freight always saw
       nothing, and a fixture-built one saw a figure IE was credited with
       confirming. They are separate facts with separate owners:

         · `packedWeightGrams` is R&D's MEASURED evidence;
         · `garmentsPerCarton` is Merchandising's APPROVED pack configuration.

       Both now arrive frozen, through `binding.packingFacts`, each with its
       own provenance. `null` is not zero: a zero packed weight would price
       freight at nothing. */
    shipment: binding.bound
      ? {
          packedWeightGrams: num(binding.packingFacts?.packedWeightGrams),
          garmentsPerCarton: num(binding.packingFacts?.garmentsPerCarton),
        }
      : null,
    applicability: {
      /* Merchandising: is this style packed at all? */
      packaging: styleApplicability.decisionView(style.materials?.packagingDecision),
      /* Production: does anything go outside? */
      outsideProcesses: styleApplicability.decisionView(style.sample?.outsideProcessDecision),
      /* Merchandising: does it need development or tooling? */
      development: styleApplicability.decisionView(style.sample?.developmentDecision),
    },
    /* When this was read. Frozen with the version so a later reader knows the
       technical record as it stood, not as it stands. */
    capturedAt: new Date(),
  };
}

module.exports = {
  CODES, BASIS, BASIS_LABEL, EVIDENCE, BLOCKER,
  /* The one place base consumption and allowance become a quantity. Exported
     so the preview, the assembly and the freeze all read one rule. */
  effectiveConsumption, withEffectiveConsumption,
  findCandidates, readStyleFacts, approvalOf, operationRow, packagingRow, serviceRow,
  /* Exported so the approved-price handoff proves a style's company the same
     way this module does, rather than growing a second ownership rule that
     could drift from it. */
  ownershipProofFor,
};

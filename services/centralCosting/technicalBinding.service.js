// services/centralCosting/technicalBinding.service.js
//
// PROVING THAT AN IMPORTED LINE IS STILL THE LINE THAT WAS IMPORTED.
//
// ── THE DEFECT THIS EXISTS TO CLOSE ─────────────────────────────────────────
// Chunk 4A snapshotted technical provenance and did not bind the CALCULATED
// INPUTS to it. The version was costed from whatever the browser posted, while
// the frozen source reference recorded what the SampleStyle actually said. A
// caller could send a real `technicalKey` beside a different consumption, a
// different item, a different unit or a different operation rate, and receive
// an immutable, internally contradictory costing: a line calculated at 3.0
// metres carrying evidence that the sample measured 1.45.
//
// That is worse than an unprovenanced costing. An unprovenanced number is
// obviously somebody's estimate; this one cites a source that contradicts it,
// and the citation is what makes it believable.
//
// ── SO EVERY IMPORTED LINE IS RE-DERIVED, NOT RE-CHECKED-AND-TRUSTED ────────
// The technical facts are read from the style at calculation time and the
// submitted line must MATCH them. Where the number is purely technical — an
// operation's per-garment cost — it is taken from the source rather than
// compared, because there is no reason for the browser to be the authority on
// it at all.
//
// ── AND A CHANGED SOURCE IS A REFUSAL, NOT A SILENT SUBSTITUTION ────────────
// If R&D re-measured between the preview and the calculation, the person is
// costing something they have not seen. Quietly using the new figure would
// produce a version nobody reviewed; quietly using the old one would freeze a
// number the source no longer says. Both are refused, with what changed.

"use strict";

const { fail } = require("../storePurchase/errors");
const { Decimal } = require("./decimal");
const technicalSource = require("./technicalSource.service");
const technicalPreview = require("./technicalPreview.service");
const labourCost = require("./labourCost");

const CODES = Object.freeze({
  STYLE_MISMATCH: "COSTING_TECHNICAL_STYLE_MISMATCH",
  SOURCE_CHANGED: "COSTING_TECHNICAL_SOURCE_CHANGED",
  STYLE_REQUIRED: "COSTING_TECHNICAL_STYLE_REQUIRED",
});

const present = (v) => v !== null && v !== undefined && v !== "";
const str = (v) => (present(v) ? String(v).trim() : "");

/** Two quantities are the same quantity, whatever they were typed as. */
function sameQuantity(a, b) {
  if (!present(a) || !present(b)) return !present(a) && !present(b);
  try {
    const x = new Decimal(String(a));
    const y = new Decimal(String(b));
    return x.isFinite() && y.isFinite() && x.isEqualTo(y);
  } catch {
    return false;
  }
}

/* Units are compared case-insensitively and trimmed, because "Metre" and
   "metre" are the same unit and refusing over the capital would be noise. Two
   genuinely different units are two different quantities. */
const sameUnit = (a, b) => str(a).toLowerCase() === str(b).toLowerCase();
const sameId = (a, b) => str(a) === str(b);

const changed = (message, details) => fail(CODES.SOURCE_CHANGED, message, {
  reason: "TECHNICAL_SOURCE_CHANGED",
  /* Every one of these is fixed the same way, and saying so is the difference
     between an error and an instruction. */
  action: "REFRESH_TECHNICAL_PREVIEW",
  ...details,
});

/**
 * Is this style one the costing may be built from?
 *
 * ── OWNERSHIP IS NOT ENOUGH ────────────────────────────────────────────────
 * `buildPreview` proves the style belongs to the actor's company. It does not
 * prove the style is about the thing this costing is about. A company costing
 * a shirt could name its own trouser style and freeze the trouser's fabric
 * consumption into the shirt's costing, with provenance that looks perfect.
 *
 * The candidate list comes from the costing's OWN context — its enquiry and
 * its product — so the check is against what this costing is for, not against
 * what the caller may see.
 *
 * ── AND THE REFUSAL DISCLOSES NOTHING ──────────────────────────────────────
 * One message for a style that is another product's, another company's, or
 * absent. A refusal that varies with the answer is a way to enumerate which
 * style ids are real.
 */
async function assertStyleBelongsToCosting(ctx, costing, styleId) {
  if (costing.context?.type !== "ENQUIRY_STYLE") {
    throw fail(CODES.STYLE_MISMATCH,
      "This costing is not raised against an enquiry style, so it has no technical record to import from.",
      { reason: "TECHNICAL_STYLE_NOT_FOR_THIS_COSTING", field: "technicalStyleId" });
  }
  const { candidates } = await technicalSource.findCandidates(ctx, {
    enquiryId: costing.context.primaryId,
    productName: costing.context.externalKey,
  });
  if (!candidates.some((c) => c.styleId === String(styleId))) {
    throw fail(CODES.STYLE_MISMATCH,
      "That technical style is not one of the styles for this costing's enquiry product.",
      {
        reason: "TECHNICAL_STYLE_NOT_FOR_THIS_COSTING",
        field: "technicalStyleId",
        /* The styles this costing MAY use — its own, so listing them
           discloses nothing the caller cannot already read. */
        available: candidates.map((c) => ({
          styleId: c.styleId, styleCode: c.styleCode, variantLabel: c.variantLabel,
        })),
      });
  }
  return candidates;
}

/* ── WHAT A MATERIAL LINE MUST STILL AGREE WITH ─────────────────────────────
 * The technical record owns the identity and the consumption. It does not own
 * the price: a rate comes from a supplier quotation or from somebody typing
 * one, and BOM provenance must never be read as the BOM having supplied it. */
function bindMaterial(line, row) {
  const field = `lines.${line.lineKey}`;
  const mismatch = (what, expected, got) => changed(
    `The technical record for ${row.rawItemName || "this material"} no longer matches this line — its ${what} differs. Refresh the technical preview and import it again.`,
    { field, lineKey: line.lineKey, technicalKey: line.technicalKey, differs: what, expected, submitted: got },
  );

  /* Category is settled by the caller — a material key posted as an operation
     is a different kind of cost, not a mismatched field. */
  if (line.behaviour !== "PER_UNIT") throw mismatch("behaviour", "PER_UNIT", line.behaviour);

  /* Identity first: a line pointing at a different item is not this row at
     all, and comparing its quantity would be answering the wrong question. */
  if (!sameId(line.itemId, row.rawItemId)) throw mismatch("item", row.rawItemId, str(line.itemId));
  if (!sameId(line.variantId, row.variantId)) throw mismatch("variant", row.variantId || null, str(line.variantId) || null);

  /* ── AGAINST THE EFFECTIVE CONSUMPTION, NOT THE BASE ────────────────────
     This compared `row.quantity` — what the garment CONTAINS — while the
     assembled line carries what one piece actually CONSUMES: the base plus
     the allowance R&D recorded beside it. Comparing the two would refuse
     every allowance-bearing material as a source mismatch.

     The check itself is unchanged in purpose and is the reason a change to
     either fact reopens everything downstream: a line whose quantity no
     longer matches the record it cites is refused, so an edited consumption
     or an edited allowance cannot be frozen against a record that has moved.

     `effectiveQuantity` falls back to `quantity` for any row shape that has
     not been through `withEffectiveConsumption` — a packaging or service row
     reaching here by another path is unaffected. */
  /* The merged preview row spells it `effectiveConsumption*`; a raw
     `technicalSource` row spells it `effectiveQuantity*`. Both are the same
     canonical number from the same function — read either, and fall back to
     the base for a row shape that predates it. */
  const effective = row.effectiveConsumptionExact ?? row.effectiveConsumptionPerPiece
    ?? row.effectiveQuantityExact ?? row.effectiveQuantity ?? row.quantity;
  if (!sameQuantity(line.quantityPerUnit, effective)) {
    throw mismatch("consumption per garment", effective, line.quantityPerUnit ?? null);
  }
  /* Both the engine's unit and the picker's, because they are the same unit
     wearing two field names and a costing where they disagree is a costing
     whose consumption means one thing and whose price means another. */
  if (!sameUnit(line.quantityUom, row.unit)) throw mismatch("unit", row.unit, str(line.quantityUom));
  if (present(line.consumptionUom) && !sameUnit(line.consumptionUom, row.unit)) {
    throw mismatch("consumption unit", row.unit, str(line.consumptionUom));
  }
  /* WHICH evidence was chosen. A line imported from the planned pick and one
     imported from the approved sample are different claims about where the
     number came from, and they can carry the same quantity. */
  if (present(line.technicalEvidence) && line.technicalEvidence !== row.chosenFrom) {
    throw mismatch("evidence basis", row.chosenFrom, line.technicalEvidence);
  }

  return {
    ...line,
    /* Normalised to the source's own spelling, so the frozen snapshot and the
       calculated line cannot differ by a capital letter. */
    /* Normalised to the source's own spelling — and to the EFFECTIVE
       quantity, which is what the costing prices and what the supplier is
       asked for. Writing the base back here would undo the allowance one
       step after the assembly applied it. */
    quantityPerUnit: String(effective),
    quantityUom: row.unit,
    ...(present(line.consumptionUom) ? { consumptionUom: row.unit } : {}),
    technicalEvidence: row.chosenFrom,
    /* THE PRICE IS NOT THE BOM'S. A quotation-backed line is still priced by
       the offer service; a typed rate is still provisional. Recorded so no
       later reader can take BOM provenance as the source of the money. */
    technicalPriceSource: line.supplierOfferId ? "SUPPLIER_QUOTATION" : "MANUAL",
  };
}

/* ── AN OPERATION'S COST IS NOT THE BROWSER'S TO SEND ───────────────────────
 * `operatorCost` is entirely derived — salary ÷ 12,480 minutes × SAM. There is
 * no judgement in it and no reason for a client to be its authority, so it is
 * TAKEN from the source rather than compared with what was posted. A posted
 * rate that disagrees is not corrected silently: the person costed something
 * else, and is told so. */
function bindOperation(line, row, { currency, policy = {}, roundingMode = "HALF_UP" }) {
  const field = `lines.${line.lineKey}`;
  const mismatch = (what, expected, got) => changed(
    `The technical record for ${row.name || row.operationCode || "this operation"} no longer matches this line — its ${what} differs. Refresh the technical preview and import it again.`,
    { field, lineKey: line.lineKey, technicalKey: line.technicalKey, differs: what, expected, submitted: got },
  );

  if (line.behaviour !== "PER_UNIT") throw mismatch("behaviour", "PER_UNIT", line.behaviour);
  /* One operation, once per garment. A quantity of 18 beside a rate that is
     already per garment multiplies the stitching by eighteen. */
  if (!sameQuantity(line.quantityPerUnit, 1)) throw mismatch("quantity per unit", "1", line.quantityPerUnit ?? null);
  if (row.costBasis !== "PER_GARMENT") {
    throw mismatch("cost basis", "PER_GARMENT", row.costBasis || null);
  }

  /* ── THE CANONICAL RATE, RECOMPUTED HERE ──────────────────────────
     This used to take `row.operatorCost` — the sample's own
     `net salary / 12,480 x SAM` — and overwrite whatever the assembly had
     calculated. So the policy-based labour rate was computed, shown in the
     preview, and then silently replaced on save by the very figure it was
     written to correct: the version froze the OLD number while the screen
     had shown the new one.

     Binding is the authoritative boundary, so the recomputation belongs here.
     It re-reads SAM and salary from the record it has just proved, and never
     restores the sample's figure once a policy rate exists. */
  const costed = labourCost.labourCostPerGarment({
    samMinutes: row.samMinutes,
    netSalaryPerMonth: row.operatorSalary,
    policy,
    roundingMode,
  });

  /* ── THE CANONICAL CALCULATION IS TRIED FIRST, NOT SECOND ─────────────
     This used to refuse the whole line before it got here if the sample
     carried no `operatorCost` — the legacy `salary / 12,480 x SAM` figure.
     So an operation with a perfectly good SAM and salary, on a company with a
     complete production policy, was rejected for missing a field the policy
     calculation does not use.

     Order now: time, salary, canonical. The legacy rate is considered only
     when the canonical one cannot be reached AND the legacy figure actually
     exists — and the line then says so through `technicalRateBasis`, so it is
     never mistaken for a policy-costed rate. */
  let derivedMinor;
  if (costed.ok) {
    derivedMinor = costed.amountMinor;
  } else if (present(row.operatorCost)) {
    derivedMinor = minorFromRupees(row.operatorCost);
  } else {
    /* Neither. Precise about which input is missing rather than "cannot be
       costed" — the fix is a different desk depending on the answer. */
    throw changed(
      `${row.name || row.operationCode || "This operation"} cannot be costed: ${costed.message}`,
      {
        field, lineKey: line.lineKey, technicalKey: line.technicalKey,
        differs: "operator rate", expected: null, submitted: null,
        reason: costed.reason,
      },
    );
  }

  return {
    ...line,
    quantityPerUnit: "1",
    /* Derived, not accepted — and from the company's own assumptions where it
       has stated them. A rate the browser sent is never used. */
    unitRate: { amountMinor: derivedMinor, currency },
    /* How it was reached, frozen beside it. `LEGACY_SAMPLE_RATE` means the
       assumptions were not configured and the sample's figure stands — which
       the assessment reports as provisional, never as verified. */
    ...(costed.ok
      ? { labourWorkings: costed.workings, technicalRateBasis: "COMPANY_POLICY" }
      : { technicalRateBasis: "LEGACY_SAMPLE_RATE" }),
    technicalEvidence: "OPERATION",
    technicalPriceSource: "OPERATION_RATE",
    technicalRateDerived: true,
  };
}

/**
 * Rupees to paise, at the one place an operation's cost crosses into money.
 *
 * `operatorCost` is stored as a rupee number to two places. Fixed to two and
 * read off the decimal string, so the assumption is explicit; absent is caught
 * before this is ever reached.
 */
function minorFromRupees(value) {
  const [whole, frac = ""] = new Decimal(String(value)).toFixed(2).split(".");
  const sign = String(whole).startsWith("-") ? -1 : 1;
  const w = Math.abs(Number(whole));
  return sign * (w * 100 + Number(frac.padEnd(2, "0").slice(0, 2)));
}

/**
 * Bind every technically-sourced line to what the style says right now.
 *
 * Returns the lines to calculate from and the preview they were bound against,
 * so the freeze step reuses ONE read of the source. Reading it twice would let
 * a change land between them, and the version would be calculated from one
 * answer and provenanced with another — the very defect this closes.
 *
 * @returns {{lines: Array, preview: object|null, styleId: string}}
 */
/**
 * Bind one packaging or service line to the requirement it claims.
 *
 * ── THE RECORD'S FIGURES WIN, AND A DIFFERENCE IS REFUSED ───────────────────
 * The same rule `bindMaterial` applies: a submitted quantity, unit or basis
 * that no longer matches the technical record is a REFUSAL rather than a
 * silent overwrite. Overwriting would produce a version that cites a row it
 * did not use; refusing sends somebody to look at what changed.
 *
 * The rate is not here at all — it comes from the quotation register, and
 * neither of these lines carries one when it arrives.
 */
function bindRequirement(line, row, { quantity, unit, basis, label }) {
  const fixed = basis === "FIXED_PER_RUN";
  /* ── A CARTON IS ITS OWN BASIS ─────────────────────────────────────────
     Neither fixed nor per-garment. The behaviour was a two-way choice here,
     so a carton line was silently rebound as PER_UNIT and then priced one
     per garment — the hundredfold error the basis check below exists to
     prevent, arriving through the check itself. */
  const carton = basis === "PER_CARTON";
  const submitted = fixed ? line.quantityPerRun : line.quantityPerUnit;
  if (present(submitted) && !sameQuantity(submitted, quantity)) {
    throw changed(
      `The technical record for ${label || line.label} no longer matches this line — its quantity differs. Refresh the technical preview.`,
      { field: `lines.${line.lineKey}`, lineKey: line.lineKey, technicalKey: line.technicalKey,
        differs: "quantity", expected: String(quantity), submitted: String(submitted) },
    );
  }
  const submittedUnit = String(line.quantityUom || "").trim();
  if (submittedUnit && submittedUnit.toLowerCase() !== String(unit || "").trim().toLowerCase()) {
    throw changed(
      `The technical record for ${label || line.label} no longer matches this line — its unit differs. Refresh the technical preview.`,
      { field: `lines.${line.lineKey}`, lineKey: line.lineKey, technicalKey: line.technicalKey,
        differs: "unit", expected: String(unit), submitted: submittedUnit },
    );
  }
  /* A basis is the difference between a carton per garment and a carton per
     order — a hundredfold error on a 500-piece run, so it is checked like a
     quantity rather than taken from the line. */
  const submittedBasis = line.behaviour === "FIXED_PER_RUN"
    ? "FIXED_PER_RUN"
    : line.behaviour === "PER_CARTON" ? "PER_CARTON" : "PER_GARMENT";
  const recordBasis = fixed ? "FIXED_PER_RUN" : carton ? "PER_CARTON" : "PER_GARMENT";
  if (submittedBasis !== recordBasis) {
    throw changed(
      `The technical record for ${label || line.label} no longer matches this line — its basis differs. Refresh the technical preview.`,
      { field: `lines.${line.lineKey}`, lineKey: line.lineKey, technicalKey: line.technicalKey,
        differs: "basis", expected: basis, submitted: submittedBasis },
    );
  }
  return {
    ...line,
    behaviour: fixed ? "FIXED_PER_RUN" : carton ? "PER_CARTON" : "PER_UNIT",
    /* A carton line's quantity is per CARTON, so it rides `quantityPerUnit`
       — the "per one of the thing this is counted in" field. What makes it a
       carton is the behaviour, which says how many of that thing a run has. */
    ...(fixed ? { quantityPerRun: String(quantity) } : { quantityPerUnit: String(quantity) }),
    /* Re-read from the technical record, never from the submitted line — the
       carton count is what turns a run size into a quantity, so a supplied
       one would change the money. */
    ...(carton ? { garmentsPerCarton: row.garmentsPerCarton ?? null } : {}),
    quantityUom: unit || "",
    technicalEvidence: row.evidence || line.technicalEvidence,
  };
}

async function bindTechnicalLines(ctx, costing, input, { asOf = new Date(), currency, policy = {} } = {}) {
  const claiming = (input.lines || []).filter((l) => l.technicalKey);
  if (!claiming.length) return { lines: input.lines, preview: null, styleId: "" };

  if (!input.technicalStyleId) {
    throw fail(CODES.STYLE_REQUIRED,
      "A line imported from a technical record must name the style it came from.",
      { field: "technicalStyleId", reason: "TECHNICAL_STYLE_REQUIRED",
        lineKeys: claiming.map((l) => l.lineKey) });
  }

  /* ── THE PRECISE REFUSAL COMES FIRST ──────────────────────────────────
     A style in ANOTHER company is a non-disclosing 404; a style in THIS
     company for a different product is a 409 that says so, because the
     caller can already see both records and "not found" would send them
     looking for a style that is sitting in front of them. The assembly
     below collapses both into the safe answer, which is right for a lookup
     and wrong here — so the specific check runs first and keeps its name. */
  await assertStyleBelongsToCosting(ctx, costing, input.technicalStyleId);

  /* ── AND THEN THE SAME ASSEMBLY THE PREVIEW USED ──────────────────────
     `assembly.assemble` proves the style belongs to this costing's own
     candidate list — which IS the company scope, built from enquiries this
     company owns through the Sales Journey — and returns the technical read.
     Going through it rather than repeating the two steps is what stops the
     screen and the save being two implementations of one thing.

     Re-read at SAVE time, deliberately: a preview somebody left open for an
     hour must not be what a version is frozen from. A row the record no
     longer carries is refused below. */
  const assembly = require("./assembly.service");
  const assembled = await assembly.assemble(ctx, costing, { styleId: input.technicalStyleId });
  if (assembled.state !== assembly.STATE.ASSEMBLED || !assembled.technical) {
    throw fail(CODES.STYLE_REQUIRED,
      "The technical record this costing was assembled from is no longer resolvable.",
      { field: "technicalStyleId", reason: assembled.state });
  }
  const preview = assembled.technical;

  const materials = new Map(preview.materials.map((m) => [m.sourceKey, m]));
  const operations = new Map(preview.operations.map((o) => [o.sourceKey, o]));
  /* ── PACKAGING AND SERVICES ARE REVALIDATED TOO ────────────────────────
     The guarantee is the same one materials have had since Chunk 4A: a
     version is frozen from what the record says NOW, not from what a preview
     said an hour ago. A packaging row whose quantity R&D has since changed,
     or a required process the style no longer carries, is refused rather than
     costed at the stale figure and snapshotted as evidence. */
  const packaging = new Map((preview.packaging || []).map((p) => [p.sourceKey, p]));
  const services = new Map((preview.services || []).map((sv) => [sv.sourceKey, sv]));

  const lines = input.lines.map((line) => {
    if (!line.technicalKey) return line;

    const material = materials.get(line.technicalKey);
    const operation = operations.get(line.technicalKey);
    const pack = packaging.get(line.technicalKey);
    const service = services.get(line.technicalKey);
    if (!material && !operation && !pack && !service) {
      /* ── A DELETED ROW IS A REFUSAL ────────────────────────────────────
         Not a version calculated from the old client value and snapshotted
         as "the technical record no longer carries this row". That reads as
         a note beside a number, when it is a reason the number should not
         exist. */
      throw changed(
        `${line.label || line.lineKey} was imported from a technical row the record no longer carries. Refresh the technical preview.`,
        { field: `lines.${line.lineKey}`, lineKey: line.lineKey, technicalKey: line.technicalKey,
          differs: "the row itself", expected: null, submitted: line.technicalKey },
      );
    }
    if (material && !material.importable) {
      throw changed(
        `${material.rawItemName || line.label} can no longer be imported: ${material.blockers?.[0]?.message || "its technical record is incomplete."}`,
        { field: `lines.${line.lineKey}`, lineKey: line.lineKey, technicalKey: line.technicalKey,
          differs: "importability", expected: null, submitted: null },
      );
    }
    if (operation && !operation.importable) {
      throw changed(
        `${operation.name || line.label} can no longer be imported: ${operation.blockers?.[0]?.message || "its technical record is incomplete."}`,
        { field: `lines.${line.lineKey}`, lineKey: line.lineKey, technicalKey: line.technicalKey,
          differs: "importability", expected: null, submitted: null },
      );
    }

    /* ── THE TWO NEW FAMILIES, ON THE SAME TERMS ────────────────────────
       Refused when the requirement can no longer be imported, refused when
       the line claims a different kind of cost, and bound to the record's own
       quantity, unit and basis rather than to whatever was submitted. */
    if (pack) {
      if (!pack.importable) {
        throw changed(
          `${pack.rawItemName || line.label} can no longer be imported: ${pack.blockers?.[0]?.message || "its packaging requirement is incomplete."}`,
          { field: `lines.${line.lineKey}`, lineKey: line.lineKey, technicalKey: line.technicalKey,
            differs: "importability", expected: null, submitted: null },
        );
      }
      if (line.category !== "PACKAGING") {
        throw changed(
          `${pack.rawItemName || line.label} is a packaging requirement on the technical record, not a ${String(line.category).toLowerCase()} cost.`,
          { field: `lines.${line.lineKey}`, lineKey: line.lineKey, technicalKey: line.technicalKey,
            differs: "category", expected: "PACKAGING", submitted: line.category },
        );
      }
      return bindRequirement(line, pack, {
        quantity: pack.quantity, unit: pack.unit, basis: pack.basis, label: pack.rawItemName,
      });
    }
    if (service) {
      if (!service.importable) {
        throw changed(
          `${service.serviceName || line.label} can no longer be imported: ${service.blockers?.[0]?.message || "its service requirement is incomplete."}`,
          { field: `lines.${line.lineKey}`, lineKey: line.lineKey, technicalKey: line.technicalKey,
            differs: "importability", expected: null, submitted: null },
        );
      }
      /* ── WHICH KIND OF COST THE RECORD SAYS IT IS ───────────────────
         A tooling requirement is a FIXED_SETUP and a process is a SERVICE;
         a line claiming the other one is not a mismatched field, it is a
         different cost — and costed the wrong way round it is out by the run
         size. */
      const expected = service.purpose === "DEVELOPMENT_TOOLING" ? "FIXED_SETUP" : "SERVICE";
      if (line.category !== expected) {
        throw changed(
          `${service.serviceName || line.label} is ${expected === "FIXED_SETUP" ? "development or tooling" : "a required process"} on the technical record, not a ${String(line.category).toLowerCase()} cost.`,
          { field: `lines.${line.lineKey}`, lineKey: line.lineKey, technicalKey: line.technicalKey,
            differs: "category", expected, submitted: line.category },
        );
      }
      return bindRequirement(line, service, {
        quantity: service.quantity, unit: service.billingUnit, basis: service.basis, label: service.serviceName,
      });
    }

    if (material) {
      /* A line claiming a material key but posted as an OPERATION is not a
         mismatched field — it is a different kind of cost. */
      if (line.category !== "MATERIAL") {
        throw changed(
          `${material.rawItemName || line.label} is a material on the technical record, not a ${String(line.category).toLowerCase()} cost.`,
          { field: `lines.${line.lineKey}`, lineKey: line.lineKey, technicalKey: line.technicalKey,
            differs: "category", expected: "MATERIAL", submitted: line.category },
        );
      }
      return bindMaterial(line, material);
    }
    if (line.category !== "OPERATION") {
      throw changed(
        `${operation.name || line.label} is an operation on the technical record, not a ${String(line.category).toLowerCase()} cost.`,
        { field: `lines.${line.lineKey}`, lineKey: line.lineKey, technicalKey: line.technicalKey,
          differs: "category", expected: "OPERATION", submitted: line.category },
      );
    }
    return bindOperation(line, operation, { currency, policy, roundingMode: policy.roundingMode });
  });

  return { lines, preview, styleId: String(input.technicalStyleId) };
}

module.exports = {
  CODES, bindTechnicalLines, assertStyleBelongsToCosting,
  bindMaterial, bindOperation, bindRequirement, sameQuantity, minorFromRupees,
};

// services/centralCosting/technicalPreview.service.js
//
// WHAT THE TECHNICAL RECORD WOULD PUT INTO THIS COSTING, BEFORE IT DOES.
//
// ── READ-ONLY, AND THAT IS THE POINT ────────────────────────────────────────
// Opening this creates nothing. A preview that quietly wrote a draft version
// would mean looking at the technical data and costing from it were the same
// act, and nobody could look without committing.
//
// ── PLANNED AND MEASURED ARE ONE MATERIAL, NOT TWO ──────────────────────────
// The Merchandiser's pick and R&D's measured consumption describe the SAME
// material. Listing both as rows would put the fabric in the costing twice and
// double the garment's material cost — the single most expensive mistake this
// import could make. They are merged onto one row as alternative evidence,
// with the chosen basis stated and the other kept visible beside it.
//
// ── AND THE CHOICE IS A RULE, NOT A PREFERENCE ──────────────────────────────
// Measured consumption supersedes the planned estimate ONLY once Sales has
// approved the sample. Before that the sample is evidence; the approved pick
// is still what was agreed. See
// docs/decisions/central-costing-technical-source-semantics.md.

"use strict";

const technicalSource = require("./technicalSource.service");
const offerRead = require("../storePurchase/supplierOfferRead.service");

const { BASIS, EVIDENCE } = technicalSource;

/* Which evidence a row is being costed from, and why that one. */
const CHOSEN = Object.freeze({
  /* R&D's approved technical record — consumption per finished piece, in a
     stated unit, with an explicit allowance. The only one of the three where
     somebody was asked for an allowance, and therefore the only one whose
     allowance a costing may apply. */
  ENGINEERED: "RND_ENGINEERED",
  MEASURED: "SAMPLE_MEASURED",
  PLANNED: "BOM_PLANNED",
  NONE: "NONE_USABLE",
});

const REASON = Object.freeze({
  ENGINEERED: "R&D's approved technical record states consumption and allowance for this material.",
  MEASURED_APPROVED: "The approved sample supersedes the planned estimate.",
  MEASURED_ONLY: "Only measured sample consumption was recorded.",
  PLANNED_ONLY: "Only a planned materials pick was recorded.",
  PLANNED_SAMPLE_UNAPPROVED:
    "The sample is not approved yet, so the planned pick still stands. The measured figure is shown beside it.",
  NONE: "Neither the planned pick nor the measured consumption can be used as recorded.",
});

/* A material is the same material when it is the same item AND the same
   physical variant. Matching on the display name would merge a navy fabric
   with an ecru one the moment somebody renamed a row. */
const identityOf = (r) => `${r.rawItemId || "?"}::${r.variantId || ""}`;

/**
 * Merge planned and measured evidence for one material into a single row.
 *
 * Both are kept. The chosen one drives the costing line; the other stays
 * visible so the person can see what the alternative said and why it was not
 * used — which is the difference between an import they can check and one they
 * have to trust.
 */
function mergeMaterial({ engineered, planned, measured, sampleApproved }) {
  const usableEngineered = engineered && engineered.importable ? engineered : null;
  const usableMeasured = measured && measured.importable ? measured : null;
  const usablePlanned = planned && planned.importable ? planned : null;

  let chosen = null;
  let chosenFrom = CHOSEN.NONE;
  let reason = REASON.NONE;

  /* ── R&D'S APPROVED RECORD OUTRANKS BOTH ────────────────────────────────
     `engineeredRow` has said so since it was written: the planned pick says
     WHICH material and nothing about how much; the measured row is evidence
     about one sample round rather than a figure for the style. This is the
     fact its owner established and Sales approved, and it is the only one
     carrying an allowance a costing may apply.
     
     It was built, returned, and read by nobody — this merge paired planned
     and measured and dropped it, so a style with a complete approved
     technical record was costed from the Merchandiser's pick. The allowance
     was not being ignored so much as the whole record was.

     Both others stay visible beside it, as they always have, so a reader can
     see what the alternatives said. */
  if (usableEngineered) {
    chosen = usableEngineered; chosenFrom = CHOSEN.ENGINEERED; reason = REASON.ENGINEERED;
  } else if (usableMeasured && sampleApproved) {
    chosen = usableMeasured; chosenFrom = CHOSEN.MEASURED; reason = REASON.MEASURED_APPROVED;
  } else if (usableMeasured && !usablePlanned) {
    /* No planned pick to prefer. The measured row is only usable at all when
       its basis was established, which without an approval means the product
       BOM confirmed it. */
    chosen = usableMeasured; chosenFrom = CHOSEN.MEASURED; reason = REASON.MEASURED_ONLY;
  } else if (usablePlanned && measured) {
    chosen = usablePlanned; chosenFrom = CHOSEN.PLANNED; reason = REASON.PLANNED_SAMPLE_UNAPPROVED;
  } else if (usablePlanned) {
    chosen = usablePlanned; chosenFrom = CHOSEN.PLANNED; reason = REASON.PLANNED_ONLY;
  }

  const shown = chosen || engineered || measured || planned;
  return {
    /* Stable across renames — the id pair, never the label. Imported rows are
       matched back to their source by this. */
    sourceKey: identityOf(shown),
    rawItemId: shown.rawItemId,
    rawItemName: shown.rawItemName,
    rawItemSku: shown.rawItemSku,
    variantId: shown.variantId,
    variantLabel: shown.variantLabel || (shown.variantCombination || []).join(" / "),
    itemInRegister: shown.itemInRegister !== false,
    registeredUnit: shown.registeredUnit || "",

    /* ── HOW MUCH ONE PIECE ACTUALLY CONSUMES ─────────────────────────────
       The three facts a reader needs to check the priced quantity without
       guessing whether the allowance was applied: what the garment contains,
       what the process adds, and the number the costing uses.

       Taken from the CHOSEN row rather than recomputed, because the chosen
       row already carries the canonical value — see
       `technicalSource.effectiveConsumption`. A second computation here would
       be a second answer. */
    consumptionPerPiece: shown.quantity ?? null,
    allowancePercent: shown.allowancePercent ?? null,
    /* True only for the legacy path, where what R&D typed was already the
       consumed amount. It is the difference between a measured 1.45 and a
       planned 1.40 plus 5%, and the reason neither is multiplied twice. */
    allowanceAlreadyInQuantity: shown.allowanceAlreadyInQuantity === true,
    effectiveConsumptionPerPiece: shown.effectiveQuantity ?? null,
    effectiveConsumptionExact: shown.effectiveQuantityExact ?? null,

    /* ── THE THREE PIECES OF EVIDENCE, SIDE BY SIDE ────────────────────
       Kept whichever was chosen, so a reader can see what the alternatives
       said and why they were not used. */
    engineered: engineered
      ? {
        quantity: engineered.quantity, unit: engineered.unit,
        /* Separate from the quantity, and therefore applied. */
        allowancePercent: engineered.allowancePercent,
        allowanceAlreadyInQuantity: false,
        effectiveQuantity: engineered.effectiveQuantityExact ?? engineered.effectiveQuantity,
        specification: engineered.specification,
        basis: engineered.basis, basisLabel: engineered.basisLabel,
        blockers: engineered.blockers,
      }
      : null,
    planned: planned
      ? {
        quantity: planned.quantity, unit: planned.unit,
        basis: planned.basis, basisLabel: planned.basisLabel,
        blockers: planned.blockers,
      }
      : null,
    measured: measured
      ? {
        quantity: measured.quantity, unit: measured.unit,
        /* Informational. Already inside `quantity`; see the adapter. */
        allowancePercent: measured.allowancePercent,
        allowanceAlreadyInQuantity: true,
        basis: measured.basis, basisLabel: measured.basisLabel,
        blockers: measured.blockers,
      }
      : null,

    chosenFrom,
    chosenReason: reason,
    supersededByApprovedSample: chosenFrom === CHOSEN.MEASURED && sampleApproved,

    /* What would go on the costing line. Null throughout when nothing usable
       was recorded — never a zero standing in for a measurement. */
    quantity: chosen ? chosen.quantity : null,
    unit: chosen ? chosen.unit : null,
    basis: chosen ? chosen.basis : BASIS.UNKNOWN,
    basisLabel: chosen ? chosen.basisLabel : technicalSource.BASIS_LABEL[BASIS.UNKNOWN],

    blockers: chosen ? [] : [...(measured?.blockers || []), ...(planned?.blockers || [])]
      /* One of each kind — the same missing unit reported twice reads as two
         problems. */
      .filter((b, i, all) => all.findIndex((x) => x.code === b.code) === i),
    importable: Boolean(chosen),
  };
}

/**
 * Can a current supplier quotation price this material?
 *
 * Asked through the same Store-owned read the picker uses, so "there is a
 * quotation" here and "there is a quotation" there cannot disagree. Only
 * whether one EXISTS — pricing it needs a run size and a consumption, which is
 * the picker's job once the row is on the costing.
 */
async function quotationAvailability(ctx, rows, { asOf }) {
  const wanted = rows.filter((r) => r.rawItemId && r.itemInRegister);
  const seen = new Map();
  for (const r of wanted) {
    const key = identityOf(r);
    if (seen.has(key)) continue;
    try {
      const offers = await offerRead.currentOffersForItem(
        { companyId: ctx.companyId, actorId: ctx.actorId, reason: "costing_technical_import" },
        r.rawItemId, { variantId: r.variantId || null, asOf },
      );
      seen.set(key, { count: offers.length, unavailable: false });
    } catch {
      /* A failed read is not an absence of quotations. Recorded as unknown so
         the row does not claim there are none. */
      seen.set(key, { count: null, unavailable: true });
    }
  }
  for (const r of rows) {
    const hit = seen.get(identityOf(r));
    r.quotation = hit
      ? {
        available: hit.count === null ? null : hit.count > 0,
        count: hit.count,
        couldNotCheck: hit.unavailable,
        /* Not a blocker on the import — the row can come in and wait for a
           quotation. It is a blocker on calling the costing complete. */
        note: hit.unavailable
          ? "Supplier quotations could not be checked."
          : (hit.count > 0 ? "" : "No current supplier quotation for this item."),
      }
      : { available: false, count: 0, couldNotCheck: false, note: "No item to price." };
  }
}

/**
 * The whole preview for one style.
 *
 * @param {{companyId, actorId}} ctx  the already-proven costing company
 * @param {string} styleId            a style the caller was offered
 */
async function buildPreview(ctx, styleId, { asOf = new Date() } = {}) {
  const facts = await technicalSource.readStyleFacts(ctx, styleId);
  const sampleApproved = facts.approval.sample.approved;

  /* ── UNCONFIRMED IS NOT EMPTY ──────────────────────────────────────────
     `readStyleFacts` publishes `null` for every costable list when Industrial
     Engineering has not confirmed this style's technical record — never `[]`,
     because an empty list is a claim nobody made and would produce a preview
     of a garment with nothing in it. The preview says WHO is waited on and
     offers nothing to import. */
  if (!facts.approvedSource?.bound) {
    return {
      style: facts.style,
      approval: facts.approval,
      technicalRecord: facts.technicalRecord,
      approvedSource: facts.approvedSource,
      /* The history is still shown: what Merchandising selected and what the
         sample consumed explain how the record got where it is. Neither is
         importable, and `mergeMaterial` is not run over them. */
      planned: facts.planned,
      measured: facts.measured,
      materials: null,
      operations: null,
      packaging: null,
      services: null,
      shipment: null,
      applicability: facts.applicability,
      capturedAt: facts.capturedAt,
      importable: false,
    };
  }

  const byIdentity = new Map();
  const put = (row, side) => {
    const key = identityOf(row);
    if (!byIdentity.has(key)) byIdentity.set(key, { engineered: null, planned: null, measured: null });
    /* A style listing the same item twice on one side is a data problem, not a
       reason to drop one silently — the first is kept and the duplicate is
       reported on the row. */
    const slot = byIdentity.get(key);
    if (slot[side]) slot.duplicated = true;
    else slot[side] = row;
  };
  for (const r of facts.engineered || []) put(r, "engineered");
  for (const r of facts.planned) put(r, "planned");
  for (const r of facts.measured) put(r, "measured");

  const materials = [];
  for (const [, slot] of byIdentity) {
    const row = mergeMaterial({
      engineered: slot.engineered, planned: slot.planned, measured: slot.measured, sampleApproved,
    });
    if (slot.duplicated) {
      row.blockers = [...row.blockers,
        { code: "DUPLICATE_SOURCE_ROW", message: "This material is recorded more than once on the technical record." }];
      row.importable = false;
    }
    materials.push(row);
  }

  await quotationAvailability(ctx, materials, { asOf });

  const operations = facts.operations.map((o) => ({
    ...o,
    /* Stable identity for matching an imported row back to its source. An
       operation code where there is one; the name only where there is not,
       which is also why a renamed operation is reported rather than silently
       re-imported as a second row. */
    sourceKey: o.operationCode ? `op::${o.operationCode}` : `op-name::${o.name.toLowerCase()}`,
    hasStableCode: Boolean(o.operationCode),
  }));

  return {
    style: facts.style,
    approval: facts.approval,
    materials,
    operations,
    /* Carried through with a stable identity, the same way an operation is:
       the key is what matches an assembled row back to the requirement it
       came from, and it has to survive a rename. */
    /* ── NULL SURVIVES THE MAP ──────────────────────────────────────────
       Both used to arrive as `[]` whenever the style was bound, because the
       read defaulted them. They are owned answers now: packaging is `null`
       when MERCHANDISING has approved none, and services are `null` when the
       frozen revision recorded no requirements at all. Mapping over that
       crashed, and defaulting it to `[]` would be worse — an empty list is the
       claim "this style needs none", which only its owner may make. */
    packaging: Array.isArray(facts.packaging)
      ? facts.packaging.map((p) => ({ ...p, sourceKey: p.requirementKey }))
      : null,
    services: Array.isArray(facts.services)
      ? facts.services.map((sv) => ({ ...sv, sourceKey: sv.requirementKey }))
      : null,
    /* The three department-owned applicability decisions, passed straight
       through. The preview reports them; it does not interpret them, and it
       certainly does not make one. */
    applicability: facts.applicability,
    /* ── AND THE TWO FACTS THAT MOVE THE ESTIMATE SILENTLY ────────────
       Which technical revision this was read from, and what the garment
       ships as. Neither appears in a cost line, and both change the answer:
       a new approved revision re-sources every material, and a packed weight
       re-prices the freight. Published so a change to either is detectable
       rather than invisible. */
    technicalRecord: facts.technicalRecord,
    /* ── THE EVIDENCE, BESIDE THE ANSWER ──────────────────────────────
       What Merchandising selected and what one sample round consumed. Neither
       is costable and neither reaches a line — `mergeMaterial` costs only the
       confirmed side — but both explain how the record got where it is, and a
       screen that showed the answer without them would make a confirmed figure
       look like the only number anybody ever wrote down.

       Published on this path as well as the unconfirmed one: the history does
       not stop being history once Industrial Engineering has confirmed. */
    planned: facts.planned,
    measured: facts.measured,
    /* ── THE THREE APPROVALS THIS PREVIEW WAS BUILT ON ───────────────
       Merchandising's selection, IE's confirmed technical revision, and the
       bulletin version that confirmed it. Carried so the freeze can record
       them and `sourceFingerprint` can detect any one being replaced.
       Identities only — no consumption, no rate, no SAM. */
    approvedSource: facts.approvedSource,
    shipment: facts.shipment,
    capturedAt: facts.capturedAt,
    /* ── WHY THIS COSTING CANNOT YET BE CALLED COMPLETE ──────────────────
       Counted here rather than left for the screen to infer, so the API and
       the UI cannot disagree about whether anything is outstanding. */
    /* A GET preview knows nothing about the unsaved draft, so every group is
       outstanding here and the screen reconciles against the live lines. The
       rule is the same one either way. */
    completeness: completenessOf({
      materials, operations, approval: facts.approval,
      packaging: facts.packaging, services: facts.services,
    }),
  };
}

/** Everything standing between this import and a costing anyone should rely on. */
function completenessOf({ materials, operations, packaging = [], services = [], approval }) {
  const outstanding = [];

  for (const m of materials) {
    for (const b of m.blockers) {
      outstanding.push({ scope: "MATERIAL", ref: m.sourceKey, label: m.rawItemName || "Unnamed material", message: b.message });
    }
    if (m.importable && m.quotation?.couldNotCheck) {
      outstanding.push({ scope: "MATERIAL", ref: m.sourceKey, label: m.rawItemName, message: m.quotation.note });
    } else if (m.importable && m.quotation?.available === false) {
      outstanding.push({ scope: "MATERIAL", ref: m.sourceKey, label: m.rawItemName, message: m.quotation.note });
    }
  }
  for (const o of operations) {
    for (const b of o.blockers) {
      outstanding.push({ scope: "OPERATION", ref: o.sourceKey, label: o.name || o.operationCode || "Unnamed operation", message: b.message });
    }
  }
  /* A requirement R&D left unfinished is outstanding on the same terms as an
     unfinished material row. Silence here would let a costing report itself
     complete while a packaging row it holds had no quantity. */
  for (const p of (packaging || [])) {
    for (const bl of p.blockers) {
      outstanding.push({ scope: "PACKAGING", ref: p.requirementKey, label: p.rawItemName || p.specification || "Packaging", message: bl.message });
    }
  }
  for (const sv of (services || [])) {
    for (const bl of sv.blockers) {
      outstanding.push({ scope: "SERVICE", ref: sv.requirementKey, label: sv.serviceName || sv.specification || "Outside service", message: bl.message });
    }
  }
  /* ── AND THE UNRESOLVED-GROUP CHECKLIST IS GONE ──────────────────────
     It listed four families no record answered, and could be closed either by
     a costing line of the right kind or by somebody in Costing writing down
     why the group did not apply. Both halves have been retired: no route
     accepts a hand-entered line, and no route accepts a Costing-side
     applicability decision. Three of the four groups are now real records
     with real owners and are assessed as FAMILIES by `costCoverage`, from
     those records; keeping a second list over the same questions is how one
     of them comes to say "answered" while the other says "open". */

  if (!approval.sample.approved) {
    outstanding.push({
      scope: "APPROVAL", ref: "sample",
      label: "Sample approval",
      message: "The sample is not approved, so the measured consumption is evidence rather than a decision.",
    });
  }

  return {
    complete: outstanding.length === 0,
    outstanding,
    /* The words the costing must be described in until `complete` is true. */
    label: "Pre-production estimated cost",
  };
}

module.exports = { buildPreview, mergeMaterial, completenessOf, identityOf, CHOSEN, REASON };

// services/centralCosting/technicalRecord.service.js
//
// R&D'S STRUCTURED TECHNICAL RECORD — WHAT IS COMPLETE, AND WHAT IS FROZEN.
//
// ── THE OWNERSHIP THIS ENFORCES ─────────────────────────────────────────────
// Merchandising selects WHICH materials. R&D establishes WHAT EACH ONE
// CONSUMES. Store prices them. Company policy converts a SAM into money. Four
// owners, four records, and this file is the boundary of the second.
//
// It therefore refuses two things that look like helpfulness:
//   · it will not let R&D change a material's identity — a wrong selection is
//     SENT BACK with a reason, so the correction has an author and a history
//     rather than appearing as if Merchandising had chosen it;
//   · it will not accept a consumption, unit or SAM from anywhere but the
//     saved record, and the costing re-reads that record rather than trusting
//     anything a browser submitted alongside it.
//
// ── AND WHY COMPLETENESS IS COMPUTED, NOT STORED ────────────────────────────
// "Is this ready to submit" is a question about the record as it stands. A
// stored flag would be a second answer that could disagree with the first, and
// the disagreement would surface as a submission that should have been
// refused.

"use strict";

const present = (v) => v !== null && v !== undefined && String(v).trim() !== "";
const str = (v) => (v === null || v === undefined ? "" : String(v).trim());
const num = (v) => {
  if (!present(v)) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const STATUS = Object.freeze({
  NOT_STARTED: "not_started",
  DRAFT: "draft",
  SUBMITTED: "submitted",
  APPROVED: "approved",
  REWORK: "rework",
});

/**
 * The families a generic requirement may belong to.
 *
 * ── PACKAGING IS ABSENT, AND THAT IS THE POINT ──────────────────────────────
 * Packaging already has a record of its own — `sample.packagingRequirements`,
 * which carries a basis (per garment, per carton, fixed per run), evidence and
 * an include/exclude decision, and which the costing has read since the family
 * was built. Offering it here too gave one fact two writable homes, and only
 * the other one was read: anything recorded through this field would have been
 * invisible to every costing that needed it.
 *
 * A row already stored under the old value is reported by
 * `retiredPackagingRequirements()` rather than silently dropped.
 */
const REQUIREMENT_FAMILIES = Object.freeze(["SERVICE", "DEVELOPMENT_TOOLING"]);

/** The value this field used to accept, kept so stored rows can be recognised. */
const RETIRED_FAMILIES = Object.freeze(["PACKAGING"]);

/**
 * Rows stored under a family this field no longer accepts.
 *
 * Compatibility, not cleanup: nothing is migrated or deleted. A style written
 * while `PACKAGING` was accepted here keeps its row, and this names it so the
 * screen can say where the fact now belongs instead of the row quietly
 * vanishing from a form that no longer offers its family.
 */
function retiredPackagingRequirements(technical = {}) {
  return (Array.isArray(technical.requirements) ? technical.requirements : [])
    .filter((r) => RETIRED_FAMILIES.includes(r?.family))
    .map((r) => ({
      name: String(r?.name ?? "").trim(),
      family: r.family,
      owner: "RND",
      message: `"${String(r?.name ?? "this requirement").trim()}" was recorded as packaging on the general requirements list, which no longer holds packaging. Record it under Packaging on the technical record — that is the record costing reads.`,
    }));
}

/** Which statuses R&D may still write to. */
const EDITABLE = Object.freeze([STATUS.DRAFT, STATUS.REWORK]);

/**
 * SAM in minutes, from the minutes/seconds R&D recorded.
 *
 * One place, because two would eventually disagree about whether 90 seconds
 * is 1.5 minutes.
 */
function samMinutesOf(op = {}) {
  const m = num(op.minutes) ?? 0;
  const s = num(op.seconds) ?? 0;
  const total = m + s / 60;
  return total > 0 ? Number(total.toFixed(6)) : null;
}

/**
 * What is missing from ONE material row, named by field and by owner.
 *
 * "R&D still needs consumption for Shell fabric" is actionable; "costing
 * incomplete" is not. Every blocker therefore carries the row it is about and
 * the desk that can clear it.
 */
function materialGaps(row = {}) {
  const gaps = [];
  const name = str(row.rawItemName) || "this material";
  if (str(row.returnedToMaterials?.reason)) {
    /* Sent back to Merchandising: not R&D's to complete, and not a gap R&D
       can be asked to close. */
    return [{
      field: "identity", owner: "MERCHANDISING", rawItemName: name,
      message: `${name} was sent back to Materials and has not been re-selected.`,
    }];
  }
  if (!present(row.specification)) {
    gaps.push({ field: "specification", owner: "RND", rawItemName: name,
      message: `R&D still needs a specification for ${name}.` });
  }
  const qty = num(row.consumptionPerPiece);
  if (qty === null || qty <= 0) {
    gaps.push({ field: "consumptionPerPiece", owner: "RND", rawItemName: name,
      message: `R&D still needs consumption per finished piece for ${name}.` });
  }
  if (!present(row.unit)) {
    gaps.push({ field: "unit", owner: "RND", rawItemName: name,
      message: `R&D still needs a consumption unit for ${name}.` });
  }
  /* The allowance is OPTIONAL but must be explicit — a null allowance means
     "R&D has not said", which is a legitimate answer and different from 0.
     Nothing is blocked by it; it is reported so the screen can show it as a
     deliberate blank rather than a forgotten field. */
  return gaps;
}

/** What is missing from one operation row. */
/* ── THE ROUTE IS PRODUCTION'S, NOT R&D'S ──────────────────────────────────
 * Which operations a garment goes through and how long each takes is
 * Production's engineering judgement. It was recorded here because this is
 * where the field lived, and the gap was reported against R&D — who could see
 * it, could not answer it, and had no way to say so.
 *
 * The record has not moved: `techSheet.technical.operations[]` is still the
 * one stored route. What moved is the OWNER, and with it the door — see
 * services/production/styleRoute.service.js. */
function operationGaps(row = {}) {
  const gaps = [];
  const name = str(row.name) || str(row.operationCode) || "this operation";
  if (!row.operationId) {
    gaps.push({ field: "operationId", owner: "PRODUCTION", operationName: name,
      message: `${name} does not name a registered operation.` });
  }
  if (samMinutesOf(row) === null) {
    gaps.push({ field: "sam", owner: "PRODUCTION", operationName: name,
      message: `Production still needs a standard time for ${name}.` });
  }
  return gaps;
}

/** What is missing from one packaging / service / development requirement. */
function requirementGaps(row = {}) {
  const gaps = [];
  const name = str(row.name) || "this requirement";
  if (!REQUIREMENT_FAMILIES.includes(row.family)) {
    gaps.push({ field: "family", owner: "RND", requirementName: name,
      message: `${name} does not name a costing family.` });
  }
  if (!present(row.name)) {
    gaps.push({ field: "name", owner: "RND", requirementName: name,
      message: "A requirement needs a name people will recognise." });
  }
  if (!present(row.specification)) {
    gaps.push({ field: "specification", owner: "RND", requirementName: name,
      message: `R&D still needs a specification for ${name}.` });
  }
  const qty = num(row.quantity);
  if (qty === null || qty <= 0) {
    gaps.push({ field: "quantity", owner: "RND", requirementName: name,
      message: `R&D still needs a quantity for ${name}.` });
  }
  if (!present(row.basis)) {
    gaps.push({ field: "basis", owner: "RND", requirementName: name,
      message: `${name} has a quantity but does not say what it is counted per.` });
  }
  if (!present(row.unit)) {
    gaps.push({ field: "unit", owner: "RND", requirementName: name,
      message: `R&D still needs a unit for ${name}.` });
  }
  if (!present(row.rationale)) {
    /* A requirement nobody justified is a cost nobody can question later. */
    gaps.push({ field: "rationale", owner: "RND", requirementName: name,
      message: `R&D still needs a reason for ${name}.` });
  }
  return gaps;
}

/**
 * Is the record ready to submit, and if not, exactly what is missing?
 *
 * @param {object} technical  `style.techSheet.technical`
 * @param {object} [opts]
 * @param {object} [opts.file] `style.techSheet.file` — evidence must accompany it
 * @param {number} [opts.approvedMaterialCount] how many the approved BOM holds
 * @param {object} [opts.shortlistBlocker] set when NOBODY has selected the
 *   materials yet — a Merchandising step, not an R&D omission
 */
function completeness(technical = {}, { file = null, approvedMaterialCount = null, shortlistBlocker = null } = {}) {
  const materials = Array.isArray(technical.materials) ? technical.materials : [];
  const operations = Array.isArray(technical.operations) ? technical.operations : [];
  const requirements = Array.isArray(technical.requirements) ? technical.requirements : [];

  const gaps = [];

  if (!materials.length) {
    /* ── WHOSE STEP IS ACTUALLY OUTSTANDING ────────────────────────────
       "No approved material has a technical record yet" reads as R&D not
       having done their work. When nobody has SELECTED the materials, the
       step belongs to Merchandising and the blocker says so — an empty form
       is not an R&D failure. */
    gaps.push(shortlistBlocker || { field: "materials", owner: "RND",
      message: "No approved material has a technical record yet." });
  }
  /* Every approved material must be accounted for — completed OR sent back.
     A shortlist row that was quietly dropped is a material the costing will
     never see and nobody will miss. */
  if (approvedMaterialCount !== null && materials.length < approvedMaterialCount) {
    gaps.push({ field: "materials", owner: "RND",
      message: `${approvedMaterialCount - materials.length} approved material(s) have no technical record yet.` });
  }
  for (const m of materials) gaps.push(...materialGaps(m));

  if (!operations.length) {
    /* Without operations there is no labour, and a garment costed with no
       stitching is not an estimate. */
    gaps.push({ field: "operations", owner: "RND",
      message: "R&D still needs the operations this style is made through." });
  }
  for (const o of operations) gaps.push(...operationGaps(o));

  /* Requirements are optional as a SECTION — plenty of styles need none. Any
     row that exists must be complete. */
  for (const r of requirements) gaps.push(...requirementGaps(r));

  if (!str(file?.url) && !str(file?.name)) {
    gaps.push({ field: "file", owner: "RND",
      message: "A technical document has to be attached as supporting evidence." });
  }

  return {
    complete: gaps.length === 0,
    gaps,
    /* Grouped so a screen can say "R&D still needs 3 things" without
       re-deriving ownership from prose. */
    byOwner: gaps.reduce((acc, g) => {
      (acc[g.owner] = acc[g.owner] || []).push(g);
      return acc;
    }, {}),
    counts: {
      materials: materials.length,
      operations: operations.length,
      requirements: requirements.length,
      returnedToMaterials: materials.filter((m) => str(m.returnedToMaterials?.reason)).length,
    },
  };
}

/**
 * The identity fields R&D may never change on a material row.
 *
 * Compared rather than trusted: a save carries whole rows, and a browser that
 * sent a different `rawItemId` would otherwise substitute the material with
 * no trace. The submitted identity has to match the approved BOM's.
 */
const IDENTITY_FIELDS = Object.freeze(["rawItemId", "variantId"]);

function identityKey(row = {}) {
  return IDENTITY_FIELDS.map((f) => String(row[f] ?? "")).join("|");
}

/**
 * Merge R&D's editable fields onto the APPROVED identities.
 *
 * The approved BOM is the spine: one output row per approved material, in the
 * approved order, carrying the approved identity. R&D's submission is matched
 * onto it by identity and contributes only its own fields. A submitted row
 * naming an identity the BOM does not hold is DROPPED, not saved — that is the
 * substitution this refuses.
 *
 * @returns {{rows: object[], rejected: object[]}}
 */
function mergeOntoApproved(approved = [], submitted = []) {
  const byIdentity = new Map();
  for (const row of Array.isArray(submitted) ? submitted : []) {
    byIdentity.set(identityKey(row), row);
  }

  const seen = new Set();
  const rows = (Array.isArray(approved) ? approved : []).map((a) => {
    const key = identityKey(a);
    seen.add(key);
    const sent = byIdentity.get(key) || {};
    return {
      /* Identity, from the APPROVED record only. */
      rawItemId: a.rawItemId,
      rawItemName: str(a.rawItemName),
      rawItemSku: str(a.rawItemSku),
      variantId: a.variantId,
      variantCombination: Array.isArray(a.variantCombination) ? a.variantCombination.map(str) : [],

      /* R&D's own fields. */
      specification: str(sent.specification),
      consumptionPerPiece: num(sent.consumptionPerPiece),
      unit: str(sent.unit),
      /* Null and 0 are different claims: "not said" and "said none". */
      allowancePercent: present(sent.allowancePercent) ? num(sent.allowancePercent) : null,
      evidenceNote: str(sent.evidenceNote),
      appliesToAllVariants: sent.appliesToAllVariants !== false,
      appliesToVariantIds: Array.isArray(sent.appliesToVariantIds) ? sent.appliesToVariantIds : [],
      appliesToVariantLabels: Array.isArray(sent.appliesToVariantLabels)
        ? sent.appliesToVariantLabels.map(str) : [],
      /* Preserved from whatever the stored row held — a send-back is its own
         action, never something a save can set.

         Only when there is a REASON: an empty object here is materialised by
         mongoose into `{ by: {} }` on every ordinary row, which reads as a
         send-back that never happened to anything checking for the field
         rather than for its reason. */
      ...(str(a.returnedToMaterials?.reason) || str(sent.returnedToMaterials?.reason)
        ? { returnedToMaterials: a.returnedToMaterials || sent.returnedToMaterials }
        : {}),
    };
  });

  const rejected = [...byIdentity.entries()]
    .filter(([key]) => !seen.has(key))
    .map(([, row]) => ({
      rawItemId: row.rawItemId ?? null,
      rawItemName: str(row.rawItemName),
      reason: "NOT_IN_APPROVED_BOM",
    }));

  return { rows, rejected };
}

/**
 * The frozen copy that goes into `technicalRevisions`.
 *
 * A plain object, deliberately: it must keep the shape it had at submission
 * rather than being re-validated against a schema that has since moved on.
 */
function snapshotOf(technical = {}, file = null) {
  return {
    revision: technical.revision ?? 0,
    materials: (technical.materials || []).map((m) => ({
      rawItemId: m.rawItemId ? String(m.rawItemId) : null,
      rawItemName: str(m.rawItemName),
      rawItemSku: str(m.rawItemSku),
      variantId: m.variantId ? String(m.variantId) : null,
      variantCombination: Array.isArray(m.variantCombination) ? m.variantCombination.map(str) : [],
      specification: str(m.specification),
      consumptionPerPiece: num(m.consumptionPerPiece),
      unit: str(m.unit),
      allowancePercent: present(m.allowancePercent) ? num(m.allowancePercent) : null,
      evidenceNote: str(m.evidenceNote),
      appliesToAllVariants: m.appliesToAllVariants !== false,
      appliesToVariantLabels: Array.isArray(m.appliesToVariantLabels) ? m.appliesToVariantLabels.map(str) : [],
      returnedToMaterials: m.returnedToMaterials
        ? { reason: str(m.returnedToMaterials.reason), at: m.returnedToMaterials.at || null }
        : null,
    })),
    operations: (technical.operations || []).map((o) => ({
      operationId: o.operationId ? String(o.operationId) : null,
      operationCode: str(o.operationCode),
      name: str(o.name),
      machineType: str(o.machineType),
      minutes: num(o.minutes) ?? 0,
      seconds: num(o.seconds) ?? 0,
      samMinutes: samMinutesOf(o),
      notes: str(o.notes),
    })),
    requirements: (technical.requirements || []).map((r) => ({
      family: str(r.family),
      name: str(r.name),
      specification: str(r.specification),
      quantity: num(r.quantity),
      basis: str(r.basis),
      unit: str(r.unit),
      rationale: str(r.rationale),
    })),
    file: file ? { name: str(file.name), url: str(file.url), uploadedAt: file.uploadedAt || null } : null,
  };
}

/** The revision a costing may read: approved, and the current one. */
function approvedRevisionOf(techSheet = {}) {
  const technical = techSheet.technical || {};
  if (technical.status !== STATUS.APPROVED) return null;
  const revisions = Array.isArray(techSheet.technicalRevisions) ? techSheet.technicalRevisions : [];
  const approved = revisions.filter((r) => r.outcome === "approved");
  if (!approved.length) return null;
  /* The highest revision number, not the last element — order in an array is
     not a guarantee, and "which one is current" must not depend on it. */
  return approved.reduce((best, r) => (r.revision > (best?.revision ?? -1) ? r : best), null);
}

module.exports = {
  STATUS,
  EDITABLE,
  REQUIREMENT_FAMILIES,
  RETIRED_FAMILIES,
  retiredPackagingRequirements,
  samMinutesOf,
  materialGaps,
  operationGaps,
  requirementGaps,
  completeness,
  identityKey,
  mergeOntoApproved,
  snapshotOf,
  approvedRevisionOf,
};

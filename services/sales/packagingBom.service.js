// services/sales/packagingBom.service.js
//
// THE ONE PACKAGING WORKFLOW: MERCHANDISING'S SELECTION, R&D'S CONSUMPTION.
//
// ── WHY THESE ARE TWO RECORDS AND ONE SCREEN ────────────────────────────────
// Packaging is part of the style's bill of materials, and a user will
// eventually see one BOM → Packaging section. Underneath there are two owners
// and therefore two records:
//
//   materials.packagingSelections[]   Merchandising — WHICH components, and
//                                     the packing instruction. No quantity.
//   sample.packagingRequirements[]    R&D — how much, on what basis, measured
//                                     or planned, and whether it is included.
//
// One record holding both is how a figure nobody measured ends up presented as
// an established fact. This file joins them for reading and for writing,
// without merging them into a single source.
//
// ── AND WHY THE JOIN IS BY ROW, NOT BY ITEM ─────────────────────────────────
// Two legitimate selections may name the same item — an inner bag and an outer
// bag. Joining on `rawItemId` alone would collapse them into one requirement
// and lose a component. So the link is the selection's own server-minted
// `rowId`, stamped onto the requirement the first time they meet.
//
// An existing requirement that predates the link is ADOPTED by item once, and
// then carries the link like any other. Nothing is backfilled and nothing is
// guessed: a style with requirements and no selections keeps working exactly
// as it did.

"use strict";

const str = (v) => (v === null || v === undefined ? "" : String(v).trim());
const id = (v) => (v === null || v === undefined ? "" : String(v));

/** Selections that have been approved — the only ones R&D is asked to cost. */
const APPROVED = "approved";
const PROPOSED = "proposed";
const WITHDRAWN = "withdrawn";

/**
 * How a requirement relates to the merchandising selection list.
 *
 * `LEGACY` is not a defect. Styles developed before selections existed have
 * requirements and no selection, and they stay readable and costable — the
 * label says where the row came from, not that something is wrong with it.
 */
const SELECTION_STATE = Object.freeze({
  APPROVED: "APPROVED",
  WITHDRAWN: "WITHDRAWN",
  LEGACY: "LEGACY",
});

/**
 * The fields R&D owns on a packaging requirement.
 *
 * Everything NOT in this list is Merchandising's or the row's own identity,
 * and is rebuilt from the approved selection on every merge rather than taken
 * from whatever was submitted. That is what stops an approved item being
 * quietly swapped for another.
 */
const RND_FIELDS = Object.freeze([
  "quantity", "unit", "basis", "evidence", "included", "excludedReason", "notes",
]);

/** Only the R&D half of a row, with nothing else carried along. */
function rndFieldsOf(row = {}) {
  const out = {};
  for (const f of RND_FIELDS) {
    if (row[f] !== undefined) out[f] = row[f];
  }
  return out;
}

/**
 * Join the two records into the rows a BOM → Packaging screen reads.
 *
 * Pure and idempotent: given the same selections and requirements it returns
 * the same rows, and running it over its own output changes nothing. That
 * matters because it runs on every read as well as on every save — a merge
 * that appended on each pass would grow a duplicate requirement per page view.
 *
 * @param {Array} selections   `materials.packagingSelections`
 * @param {Array} requirements `sample.packagingRequirements`
 * @returns {{rows: object[], requirements: object[], adopted: object[]}}
 *   `rows` is the read model; `requirements` is what to store back.
 */
function mergePackaging(selections = [], requirements = []) {
  const sels = Array.isArray(selections) ? selections : [];
  const reqs = Array.isArray(requirements) ? requirements : [];

  /* Indexed two ways, because a requirement may already carry the link or may
     predate it entirely. */
  const byLink = new Map();
  const byItem = new Map();
  for (const r of reqs) {
    const link = str(r.sourceSelectionRowId);
    if (link) {
      byLink.set(link, r);
      continue;
    }
    /* First unlinked row for an item is the adoption candidate. A second one
       stays unlinked and is reported as legacy rather than being attached to
       a selection nobody said it belonged to. */
    const key = id(r.rawItemId);
    if (key && !byItem.has(key)) byItem.set(key, r);
  }

  const rows = [];
  const out = [];
  const adopted = [];
  const consumed = new Set();

  for (const sel of sels) {
    const rowId = str(sel.rowId);
    const status = str(sel.status) || PROPOSED;

    /* ── A PROPOSAL IS NOT YET WORK FOR R&D ────────────────────────────
       It is shown, so Merchandising can see what they have put forward, and
       it seeds nothing: asking R&D to measure a component nobody has agreed
       to is how a technical record fills up with rows that never ship. */
    if (status === PROPOSED) {
      rows.push({
        rowId, selectionStatus: PROPOSED, seeded: false,
        rawItemId: id(sel.rawItemId), rawItemName: str(sel.rawItemName),
        rawItemSku: str(sel.rawItemSku), specification: str(sel.specification),
        requirement: null,
      });
      continue;
    }

    let existing = byLink.get(rowId) || null;
    if (!existing) {
      /* ── ADOPTION, ONCE ────────────────────────────────────────────
         A requirement R&D recorded before this link existed, for the item
         this selection names. It keeps every figure it holds and gains the
         link, so the next merge finds it by row and this branch never runs
         for it again. */
      const candidate = byItem.get(id(sel.rawItemId));
      if (candidate && !consumed.has(candidate)) {
        existing = candidate;
        consumed.add(candidate);
        adopted.push({ rowId, rawItemId: id(sel.rawItemId), rawItemName: str(sel.rawItemName) });
      }
    }
    if (existing) consumed.add(existing);

    /* ── WITHDRAWN NEVER DELETES ───────────────────────────────────────
       R&D may have measured it; a costing version may have frozen it. The
       requirement stays exactly as it is and the row says the component was
       withdrawn and why, so the lifecycle is visible instead of the row
       silently disappearing. */
    if (status === WITHDRAWN) {
      if (existing) out.push(existing);
      rows.push({
        rowId, selectionStatus: WITHDRAWN, seeded: Boolean(existing),
        rawItemId: id(sel.rawItemId), rawItemName: str(sel.rawItemName),
        rawItemSku: str(sel.rawItemSku), specification: str(sel.specification),
        withdrawnReason: str(sel.withdrawnReason),
        withdrawnAt: sel.withdrawnAt || null,
        requirement: existing ? publicRequirement(existing) : null,
      });
      continue;
    }

    /* ── APPROVED: ONE REQUIREMENT, IDENTITY FROM THE SELECTION ────────
       Rebuilt rather than merged field-by-field, so an item id or an approved
       specification submitted on the requirement contributes nothing. R&D's
       own fields are carried through untouched. */
    const merged = {
      ...(existing ? rndFieldsOf(existing) : {}),
      rowId: existing?.rowId || rowId,
      sourceSelectionRowId: rowId,
      rawItemId: sel.rawItemId,
      rawItemName: str(sel.rawItemName),
      rawItemSku: str(sel.rawItemSku),
      ...(sel.variantId ? { variantId: sel.variantId } : {}),
      variantLabel: str(sel.variantLabel),
      /* Merchandising's packing instruction is authoritative. R&D's own
         observations belong in `notes`, which is theirs. */
      specification: str(sel.specification),
    };
    out.push(merged);
    rows.push({
      rowId, selectionStatus: APPROVED, seeded: true,
      rawItemId: id(sel.rawItemId), rawItemName: str(sel.rawItemName),
      rawItemSku: str(sel.rawItemSku), specification: str(sel.specification),
      requirement: publicRequirement(merged),
    });
  }

  /* ── EVERYTHING R&D RECORDED THAT NO SELECTION CLAIMS ──────────────────
     Legacy styles, and any row whose selection was removed outright. Kept,
     costable, and labelled — never backfilled into a selection nobody made. */
  for (const r of reqs) {
    if (consumed.has(r)) continue;
    if (str(r.sourceSelectionRowId) && sels.some((s) => str(s.rowId) === str(r.sourceSelectionRowId))) continue;
    out.push(r);
    rows.push({
      rowId: str(r.rowId), selectionStatus: SELECTION_STATE.LEGACY, seeded: true,
      rawItemId: id(r.rawItemId), rawItemName: str(r.rawItemName),
      rawItemSku: str(r.rawItemSku), specification: str(r.specification),
      requirement: publicRequirement(r),
    });
  }

  return { rows, requirements: out, adopted };
}

/**
 * What leaves the server for one requirement.
 *
 * An allowlist. A rate, a supplier and a carton capacity must never travel on
 * packaging data — the first two are Store's and the third is stated once for
 * the whole style on `sample.shipment`. Publishing the stored row wholesale
 * would make that a convention rather than a fact.
 */
function publicRequirement(r = {}) {
  return {
    rowId: str(r.rowId),
    sourceSelectionRowId: str(r.sourceSelectionRowId),
    rawItemId: id(r.rawItemId),
    rawItemName: str(r.rawItemName),
    rawItemSku: str(r.rawItemSku),
    specification: str(r.specification),
    quantity: r.quantity === undefined || r.quantity === null ? null : Number(r.quantity),
    unit: str(r.unit),
    basis: str(r.basis) || "PER_GARMENT",
    evidence: str(r.evidence),
    included: r.included !== false,
    excludedReason: str(r.excludedReason),
    notes: str(r.notes),
  };
}

/**
 * The only fact about R&D's work that returns to Merchandising.
 *
 * Merchandising needs to know whether its approved component has made it
 * through the sampling handoff. It does not need — and must not receive — the
 * measurement, its unit, evidence, notes, exclusion reason or shipment facts.
 * Keeping this small derived state here also means the same-row link remains
 * the source of truth when two components use the same Item Master entry.
 */
function merchandisingHandoff(row = {}) {
  const req = row.requirement;
  if (row.selectionStatus === PROPOSED) {
    return { state: "AWAITING_APPROVAL", label: "Awaiting approval" };
  }
  if (row.selectionStatus === WITHDRAWN) {
    return {
      state: req ? "WITHDRAWN_WITH_RND_RECORD" : "WITHDRAWN",
      label: req ? "Withdrawn — R&D record retained" : "Withdrawn",
    };
  }
  if (!req || (req.included !== false && (!(req.quantity > 0) || !req.unit))) {
    return { state: "RND_CONSUMPTION_REQUIRED", label: "R&D consumption still required" };
  }
  if (req.included === false) {
    return { state: "RND_REVIEW_RECORDED", label: "R&D review recorded" };
  }
  return { state: "RND_CONSUMPTION_RECORDED", label: "R&D consumption recorded" };
}

/**
 * What R&D still owes on the merged rows, by owner.
 *
 * The carton conversion is reported against the SHIPMENT, not the row: it is
 * one fact for the style, shared with freight, and a per-row copy would let
 * one style hold two answers.
 */
function readiness(rows = [], { garmentsPerCarton = null } = {}) {
  const gaps = [];
  for (const row of rows) {
    const req = row.requirement;
    if (!req || row.selectionStatus === PROPOSED || row.selectionStatus === WITHDRAWN) continue;
    if (req.included === false) continue;
    const name = req.rawItemName || row.rawItemName || "this packaging";
    if (req.quantity === null || !(req.quantity > 0)) {
      gaps.push({ owner: "RND", rowId: row.rowId, field: "quantity",
        message: `R&D still needs the consumption for ${name}.` });
    }
    if (!req.unit) {
      gaps.push({ owner: "RND", rowId: row.rowId, field: "unit",
        message: `R&D still needs a unit for ${name}.` });
    }
    if (req.basis === "PER_CARTON" && !(Number(garmentsPerCarton) > 0)) {
      gaps.push({ owner: "RND", rowId: row.rowId, field: "shipment.garmentsPerCarton",
        message: `${name} is bought by the carton, and the shipment does not say how many garments a carton holds. Record it once in Shipment — freight reads the same number.` });
    }
  }
  return { ready: gaps.length === 0, gaps };
}


/**
 * One selected packaging component, as anything outside this record may see it.
 *
 * The projection moved here from the Sales style router when the Merchandising
 * packaging endpoints moved to their own. It belongs beside `publicRequirement`
 * — the two are the halves of one row, Merchandising's identity and R&D's
 * consumption — and having one of them in a router meant the shape a caller
 * received depended on which door they came through.
 */
function publicSelection(r) {
  return {
    rowId: String(r.rowId || ""),
    rawItemId: String(r.rawItemId || ""),
    rawItemName: r.rawItemName || "",
    rawItemSku: r.rawItemSku || "",
    specification: r.specification || "",
    status: r.status || "proposed",
    selectedByName: r.selectedBy?.name || "",
    selectedAt: r.selectedAt || null,
    withdrawnReason: r.withdrawnReason || "",
    withdrawnAt: r.withdrawnAt || null,
  };
}
module.exports = {
  APPROVED, PROPOSED, WITHDRAWN, SELECTION_STATE, RND_FIELDS,
  mergePackaging, publicRequirement, publicSelection, merchandisingHandoff, readiness,
};

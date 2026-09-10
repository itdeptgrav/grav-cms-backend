// services/approvedMaterialShortlist.service.js
//
// THE ONE ANSWER TO "WHICH MATERIALS IS R&D EXPECTED TO COMPLETE?"
//
// ── THE DISAGREEMENT THIS ENDS ──────────────────────────────────────────────
// The R&D style page shows an Approved Bill of Materials panel, fed by
// `GET /:id/production` → `stockItemBom()`, which walks the linked finished
// good's variants and merges their raw-item rows. The technical record seeded
// from `style.materials.rawItems` instead — a field only the RETIRED
// materials-picking form ever wrote, and which `stockItemBom`'s own comment
// already records as "simply empty" for every style raised since 26 Aug 2026.
//
// So one screen showed `POLO 150` while the other said "no approved material
// has a technical record yet" and blocked submission. Two sources, two
// answers, and R&D blamed for neither.
//
// This resolves it once, and every technical-record path reads it: the GET,
// the save, the seeding when a tech sheet starts, return-to-materials, and
// the completeness gate. They cannot disagree because there is nothing left
// to disagree with.
//
// ── AND IT RETURNS IDENTITY ONLY ────────────────────────────────────────────
// The BOM rows carry `quantity`, `allowancePercent`, `unitCost` and
// `totalCost`. None of them crosses this boundary. A BOM quantity is what a
// previous product was built with; it is not R&D's engineered consumption for
// THIS style, and copying it in would recreate the exact mistake the technical
// record exists to correct — a figure presented as established that nobody
// established. R&D states consumption, unit and allowance, or the record is
// incomplete and says so.

"use strict";

const StockItem = require("../models/CMS_Models/Inventory/Products/StockItem");
const {
  DevelopmentFile, DevelopmentBomRevision, BOM_STATE,
} = require("../models/CMS_Models/Merchandising/Development");
const { stockItemBom } = require("./sampleStyleEmail.service");

/** The linked finished good — the same precedence every other reader uses. */
const linkedStockItemId = (style) =>
  style?.production?.stockItemId || style?.sourceStockItemId || null;

const str = (v) => (v === null || v === undefined ? "" : String(v).trim());

/** Identity, and nothing that could be mistaken for an R&D fact. */
function identityRow(r, { source }) {
  return {
    rawItemId: r.rawItemId,
    rawItemName: str(r.rawItemName),
    rawItemSku: str(r.rawItemSku),
    /* The RAW ITEM's own physical variant — the colour/vendor combination
       Merchandising selected, not a product size. */
    variantId: r.variantId ?? undefined,
    variantCombination: Array.isArray(r.variantCombination)
      ? r.variantCombination.map(str).filter(Boolean) : [],
    /* Which product variants the row was found on. Shown so R&D can see a
       row is size-specific; it is not a consumption. */
    appliesToVariantLabels: Array.isArray(r.variantLabels)
      ? r.variantLabels.map(str).filter(Boolean) : [],
    /* Where this identity came from, so a reader is never left guessing why
       a row is or is not there. */
    source,
  };
}

/**
 * The approved materials R&D must complete, for one style.
 *
 * @param {object} style a SampleStyle (lean or document)
 * @returns {Promise<{
 *   rows: object[], source: "FINISHED_GOOD_BOM"|"LEGACY_STYLE_PICK"|"NONE",
 *   stockItemId: string|null, blocker: object|null,
 * }>}
 */
async function approvedShortlistFor(style) {
  const stockItemId = linkedStockItemId(style);

  /* ── 1. MERCHANDISING'S OWN APPROVED DEVELOPMENT SELECTION ──────────────
     The pre-order workflow's answer, and it outranks everything below it.

     Before this existed, the best available source was the finished good's
     BOM — what a PREVIOUS product was built from — because nothing recorded
     what Merchandising had chosen for THIS style. Now something does, and it
     is the only source on this list that was selected for this style, by the
     department that owns material selection, and put through maker/checker.

     A registered product's BOM stays below it precisely because a repeat
     order's materials are usually right and occasionally not: when
     Merchandising has looked and approved a selection, that selection is the
     answer even where it is identical to the product's. */
  const development = await approvedDevelopmentSelectionFor(style);
  if (development?.rows.length) {
    return {
      rows: development.rows.map((r) => identityRow(r, { source: "DEVELOPMENT_BOM" })),
      source: "DEVELOPMENT_BOM",
      stockItemId: stockItemId ? String(stockItemId) : null,
      developmentNumber: development.developmentNumber,
      developmentBomRevisionNo: development.revisionNo,
      blocker: null,
    };
  }

  /* ── 2. THE REGISTERED PRODUCT'S BOM ────────────────────────────────── */
  if (stockItemId) {
    const stockItem = await StockItem.findById(stockItemId)
      .select("name reference variants").lean().catch(() => null);
    const bom = stockItemBom(stockItem);
    if (bom.length) {
      return {
        rows: bom.map((r) => identityRow(r, { source: "FINISHED_GOOD_BOM" })),
        source: "FINISHED_GOOD_BOM",
        stockItemId: String(stockItemId),
        blocker: null,
      };
    }
  }

  /* ── 3. THE LEGACY FALLBACK, NAMED AS ONE ──────────────────────────────
     `style.materials.rawItems` is what the retired materials-picking form
     wrote. Styles raised before 26 Aug 2026 have it and have no finished
     good, so it is the only record of what was selected for them — which is
     why it is kept rather than dropped. It is never preferred: a style with
     BOTH reads its finished good, because that is what the screen shows. */
  const legacy = Array.isArray(style?.materials?.rawItems) ? style.materials.rawItems : [];
  if (legacy.length) {
    return {
      rows: legacy.map((r) => identityRow(r, { source: "LEGACY_STYLE_PICK" })),
      source: "LEGACY_STYLE_PICK",
      stockItemId: stockItemId ? String(stockItemId) : null,
      blocker: null,
    };
  }

  /* ── 4. NONE — AND THAT IS NOT R&D'S FAILURE ────────────────────────────
     An empty form with "R&D still needs consumption" against nothing reads
     as R&D not having done their work. Nobody has selected the materials
     yet, and the blocker says whose step that is. */
  return {
    rows: [],
    source: "NONE",
    stockItemId: stockItemId ? String(stockItemId) : null,
    blocker: {
      owner: "MERCHANDISING",
      field: "materials",
      /* Wording kept compatible with the R&D suite that pins this sentence:
         the claim it makes — the blocker names Merchandising, never R&D — is
         the point, and the Development file is named as the place to go. */
      message: stockItemId
        ? "No approved materials are on this style's finished good yet, and no development "
          + "selection has been approved — Merchandising selects the materials, on its Development "
          + "file, before R&D can record consumption."
        : "This style has no approved bill of materials yet — Merchandising selects the materials, "
          + "on its Development file, before R&D can record consumption.",
    },
  };
}

/**
 * The approved Development BOM for the style's Journey product line, if there
 * is one.
 *
 * Resolved through the SAMPLE STYLE, because that is what R&D and Costing hold
 * — neither of them knows about a product line reference, and neither should
 * have to. The Development File records which style it was opened for, so the
 * join is a lookup rather than a guess.
 *
 * Identity only, as everywhere else on this boundary: the development BOM has
 * no consumption to leak, by construction.
 */
async function approvedDevelopmentSelectionFor(style) {
  const styleId = style?._id;
  if (!styleId) return null;

  const file = await DevelopmentFile.findOne({ sampleStyleId: styleId })
    .select("_id developmentNumber currentBomRevisionNo companyId").lean().catch(() => null);
  if (!file?.currentBomRevisionNo) return null;

  const revision = await DevelopmentBomRevision.findOne({
    companyId: file.companyId,
    developmentFileId: file._id,
    state: BOM_STATE.APPROVED,
  }).select("revisionNo rows").lean().catch(() => null);
  if (!revision?.rows?.length) return null;

  return {
    developmentNumber: String(file.developmentNumber || ""),
    revisionNo: revision.revisionNo,
    rows: revision.rows.map((r) => ({
      rawItemId: r.rawItemId,
      rawItemName: r.rawItemName,
      rawItemSku: r.rawItemSku,
      variantId: r.variantId,
      variantCombination: r.variantCombination,
      /* Which part of the garment the selection is for, shown so R&D can see
         a row is placement-specific. It is not a consumption. */
      variantLabels: r.appliesTo ? [r.appliesTo] : [],
    })),
  };
}

module.exports = {
  approvedShortlistFor, linkedStockItemId, approvedDevelopmentSelectionFor,
};

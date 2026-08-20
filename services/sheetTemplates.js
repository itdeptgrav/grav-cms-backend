// services/sheetTemplates.js
//
// Builds the pre-filled cell content for a new costing sheet, in the exact
// JSON shape CoWork's own sheet grid reads and writes (Cowork/lib/rules/
// sheets/grid.ts — Workbook / SheetTab / CellMap). Nothing here talks to
// Firestore; it only produces the object services/coworkSheets.service.js's
// createSheet() JSON.stringifies into cowork_document_bodies/{id}.cells.
//
// Format follows the "BOM Inquiry Cost" workbook supplied as the reference —
// a raw-items BOM (filled in during costing) and an Inquiry Costing summary
// (buyer/product info known today, pre-filled; costs filled in as the BOM is
// worked out). Only the STRUCTURE is templated — category rows, headers,
// formulas — never the reference file's own example vendor rows, which
// belonged to a different, unrelated product.
//
// ─── ONE WORKBOOK PER CONTRIBUTOR (17 Aug 2026) ──────────────────────────────
//
// The costing used to be one document with those two tabs, shared with both the
// merchandiser and the industrial engineer. That cannot express who owns what:
// CoWork's roles are WHOLE-DOCUMENT (owner|editor|viewer, see
// coworkSheets.service.js's SHARE_ROLES) — there is no per-tab or per-range
// permission, so "merch fills the materials, IE fills the operations" was a
// convention nothing enforced, and either one could overwrite the other's work.
//
// So a costing is now TWO documents, one per contributor:
//
//   buildRawMaterialsWorkbook()  → the merchandiser is its editor
//   buildOperationsWorkbook()    → the industrial engineer is its editor
//
// Each carries the same buyer/product context block, because each now stands on
// its own in CoWork and whoever opens it needs the spec without going to find
// the other one.
//
// WHAT THE SPLIT COSTS: the old summary tab pulled the raw-material total
// across tabs with `='Raw Items Detail'!G17`. A formula cannot reach into
// another DOCUMENT, so that line is gone and neither sheet computes total FOB.
// The CMS composes both sheets and totals them (lib/salesJourney/costingModel
// on the front end) — which is the right home for it anyway, since only the CMS
// knows both documents exist.
//
// buildCostingWorkbook() (the old combined two-tab workbook) is kept for the
// costings created before this, which are still live documents in CoWork.
"use strict";

/** A1-style column letters for 0-based column index (0 -> "A", 26 -> "AA"). */
function colLetter(i) {
  let n = i + 1;
  let s = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function ref(col, row) {
  return `${colLetter(col)}${row}`;
}

/** Raw-items BOM categories, in the order the reference file used them. */
const RAW_ITEM_CATEGORIES = [
  "Fabric",
  "Thread",
  "Button",
  "Fusing",
  "Trims & Accessory",
  "Packing Materials",
];

/** Bold-ish section/heading style, kept minimal — CellStyle per grid.ts. */
const HEAD_STYLE = { bold: true };
const TITLE_STYLE = { bold: true, size: 14 };

/**
 * Buyer info + product specification + reference images, written from `r`
 * downwards. Extracted verbatim from the summary tab so that every sheet a
 * contributor opens carries the same context — a split costing means the IE
 * never sees the merchandiser's sheet, and vice versa.
 *
 * @returns {number} the next free row.
 */
function writeContextBlock(cells, styles, { enquiry, product }, startRow) {
  let r = startRow;

  cells[ref(0, r)] = "Buyer Info";
  styles[ref(0, r)] = HEAD_STYLE;
  r += 1;
  const buyer = [
    ["Customer", enquiry?.customerName || enquiry?.accountName || ""],
    ["Enquiry ID", enquiry?.enquiryId || ""],
    ["Enquiry Date", enquiry?.enquiryDate ? new Date(enquiry.enquiryDate).toLocaleDateString("en-IN") : ""],
  ];
  for (const [label, value] of buyer) {
    cells[ref(0, r)] = label;
    cells[ref(1, r)] = value;
    r += 1;
  }

  // ── Product details/specifications — filled from the specific product
  // this costing sheet is for; blank fields just render as empty rows,
  // not "N/A", so a half-specified enquiry doesn't look broken. ─────────
  r += 1;
  cells[ref(0, r)] = "Products Details/Specifications";
  styles[ref(0, r)] = HEAD_STYLE;
  r += 1;
  const specRows = [
    ["Product", product?.product],
    ["Quantity", product?.quantity != null ? String(product.quantity) : ""],
    ["Description", product?.note],
    ["Gender", product?.gender],
    ["Colour", product?.colour],
    ["Fabric preference", product?.fabricPreference],
    ["Composition", product?.fabricComposition],
    ["GSM", product?.gsm],
    ["Fit", product?.fit],
    ["Size range", product?.sizeRange],
    ["Trims", product?.trims],
    ["Branding", [product?.logo && "Logo", product?.embroidery && "Embroidery", product?.printing && "Printing"].filter(Boolean).join(", ")],
    ["Branding placement", product?.brandingPlacement],
    ["Special construction", product?.specialConstruction],
  ];
  for (const [label, value] of specRows) {
    if (!value) continue;
    cells[ref(0, r)] = label;
    cells[ref(1, r)] = String(value);
    r += 1;
  }

  // ── Reference images — a plain URL per image, not an embed. CoWork's
  // sheet cells are text (Cowork/lib/rules/sheets/grid.ts's CellMap is
  // Record<A1ref, string>) with no image-cell type, so there is nowhere in
  // this format to actually place a picture; a URL anyone can open is the
  // honest version of "put the image on the sheet" until CoWork's own grid
  // grows a real image cell type. One row per image, so Merchandising & IE
  // don't have to hunt through the enquiry page for them.
  const images = Array.isArray(product?.images) ? product.images : [];
  if (images.length) {
    cells[ref(0, r)] = images.length === 1 ? "Reference image" : "Reference images";
    styles[ref(0, r)] = HEAD_STYLE;
    for (const img of images) {
      const url = img?.url || (img?.fileId ? `https://drive.google.com/file/d/${img.fileId}/view` : "");
      if (!url) continue;
      cells[ref(1, r)] = url;
      r += 1;
    }
  }

  return r;
}

/**
 * The raw-items BOM table.
 *
 * `context` is optional and only supplied for the standalone (split) sheet —
 * omitting it reproduces the combined workbook's first tab exactly, cell for
 * cell, which is what the pre-split costings out there already contain.
 */
function buildRawItemsSheet(context = null) {
  const cells = {};
  const styles = {};

  let headerRow = 3;
  if (context) {
    cells[ref(0, 1)] = "Grav Clothing Pvt Ltd";
    styles[ref(0, 1)] = TITLE_STYLE;
    cells[ref(0, 2)] = "Raw Materials Costing — Merchandising";
    styles[ref(0, 2)] = HEAD_STYLE;
    headerRow = writeContextBlock(cells, styles, context, 4) + 1;
  } else {
    cells[ref(0, 1)] = "Raw Items Details";
    styles[ref(0, 1)] = TITLE_STYLE;
  }

  // Column layout: 0 Sl no, 1 Category, 2 Raw item, 3 Variant/Vendor,
  // 4 Unit cost, 5 Unit, 6 Consumption (with allowance), 7 Total cost.
  // "Unit" sits next to Consumption on purpose — consumption is meaningless
  // without the unit it's counted in, and CostingSheetView.js special-cases
  // this exact column (by sheet name + column index) to render it as a
  // dropdown instead of free text (20 Aug 2026, explicit request — the raw
  // item name here is typed text, not a RawItem._id, so the dropdown offers
  // every registered unit rather than trying to resolve item-specific
  // conversions from a fuzzy name match).
  const headers = ["Sl no", "Category", "Raw item", "Variant / Vendor", "Unit cost", "Unit", "Consumption (with allowance)", "Total cost"];
  headers.forEach((h, i) => {
    cells[ref(i, headerRow)] = h;
    styles[ref(i, headerRow)] = HEAD_STYLE;
  });

  // One category label row + one blank entry row per category, so the
  // person costing it has a clear place to type each raw item without
  // guessing the layout. Total cost is a formula from the start — filling
  // in unit cost and consumption is all that's needed for it to compute.
  let row = headerRow + 1;
  const totalCostCells = [];
  for (const category of RAW_ITEM_CATEGORIES) {
    cells[ref(1, row)] = category;
    styles[ref(1, row)] = HEAD_STYLE;
    row += 1;

    const dataRow = row;
    cells[ref(0, dataRow)] = String(totalCostCells.length + 1);
    cells[ref(7, dataRow)] = `=${ref(4, dataRow)}*${ref(6, dataRow)}`;
    totalCostCells.push(ref(7, dataRow));
    row += 1;
  }

  row += 1;
  cells[ref(1, row)] = "Total Raw Material Cost";
  styles[ref(1, row)] = HEAD_STYLE;
  cells[ref(7, row)] = `=SUM(${totalCostCells[0]}:${totalCostCells[totalCostCells.length - 1]})`;
  styles[ref(7, row)] = HEAD_STYLE;
  const rawMaterialTotalRef = ref(7, row);

  return {
    id: "sheet-1",
    name: "Raw Items Detail",
    cells,
    styles,
    rows: 200,
    cols: 26,
    rawMaterialTotalRef, // returned for the summary tab's cross-sheet formula, not part of the schema
  };
}

/**
 * The industrial engineer's sheet: the same context, then operations.
 *
 * It deliberately stops at "Total Operation Cost". Total FOB would need the
 * raw-material total, which now lives in a different CoWork document and no
 * formula can reach it — so the sheet says what it knows and the CMS adds the
 * two together. Claiming an FOB here that silently excluded materials would be
 * worse than not showing one.
 *
 * The tab keeps the name "Inquiry Costing" so one reader
 * (lib/salesJourney/costingModel) parses split and combined sheets alike.
 */
function buildOperationsSheet({ enquiry, product }) {
  const cells = {};
  const styles = {};

  cells[ref(0, 1)] = "Grav Clothing Pvt Ltd";
  styles[ref(0, 1)] = TITLE_STYLE;
  cells[ref(0, 2)] = "Operation Costing — Industrial Engineering";
  styles[ref(0, 2)] = HEAD_STYLE;

  let r = writeContextBlock(cells, styles, { enquiry, product }, 4) + 1;

  cells[ref(0, r)] = "Operation Cost";
  styles[ref(0, r)] = HEAD_STYLE;
  r += 1;

  const opHeaderRow = r;
  cells[ref(0, opHeaderRow)] = "Sl";
  cells[ref(1, opHeaderRow)] = "Operation Details";
  cells[ref(2, opHeaderRow)] = "SAM";
  cells[ref(3, opHeaderRow)] = "Cost Per Mint";
  cells[ref(4, opHeaderRow)] = "CMP";
  [0, 1, 2, 3, 4].forEach((c) => { styles[ref(c, opHeaderRow)] = HEAD_STYLE; });
  r += 1;

  // A few blank costed rows rather than one: an operation breakdown is
  // normally several lines, and a person who has to discover "add a row"
  // before they can start tends to put everything on the one row that exists.
  const first = r;
  for (let i = 0; i < 6; i += 1) {
    cells[ref(0, r)] = String(i + 1);
    cells[ref(4, r)] = `=${ref(2, r)}*${ref(3, r)}`;
    r += 1;
  }
  const last = r - 1;

  r += 1;
  cells[ref(0, r)] = "Total Operation Cost";
  styles[ref(0, r)] = HEAD_STYLE;
  cells[ref(4, r)] = `=SUM(${ref(4, first)}:${ref(4, last)})`;
  styles[ref(4, r)] = HEAD_STYLE;
  r += 2;

  cells[ref(0, r)] = "Total FOB (raw materials + operations) is worked out in the CMS, which holds both sheets.";

  return { id: "sheet-1", name: "Inquiry Costing", cells, styles, rows: 200, cols: 26 };
}

function buildCostingSummarySheet({ enquiry, product, rawMaterialTotalRef, sheetOneName }) {
  const cells = {};
  const styles = {};

  cells[ref(0, 1)] = "Grav Clothing Pvt Ltd";
  styles[ref(0, 1)] = TITLE_STYLE;
  cells[ref(0, 2)] = "Inquiry Costing";
  styles[ref(0, 2)] = HEAD_STYLE;

  let r = writeContextBlock(cells, styles, { enquiry, product }, 4);

  // ── Raw items cost, pulled from the BOM tab rather than re-entered ───
  r += 1;
  const rmHeaderRow = r;
  cells[ref(0, rmHeaderRow)] = "Sl no";
  cells[ref(1, rmHeaderRow)] = "Items Description";
  cells[ref(2, rmHeaderRow)] = "Consumption With 10% Allowance";
  cells[ref(3, rmHeaderRow)] = "Unit Cost";
  cells[ref(4, rmHeaderRow)] = "Total Cost";
  [0, 1, 2, 3, 4].forEach((c) => { styles[ref(c, rmHeaderRow)] = HEAD_STYLE; });
  r += 1;
  cells[ref(1, r)] = "Raw materials (see " + sheetOneName + ")";
  cells[ref(4, r)] = `='${sheetOneName}'!${rawMaterialTotalRef}`;
  const rawMaterialsLineRef = ref(4, r);
  r += 1;

  // ── Operation cost — CMP/SAM, the manufacturing side of FOB ──────────
  r += 1;
  cells[ref(0, r)] = "Operation Cost";
  styles[ref(0, r)] = HEAD_STYLE;
  r += 1;
  const opHeaderRow = r;
  cells[ref(0, opHeaderRow)] = "Sl";
  cells[ref(1, opHeaderRow)] = "Operation Details";
  cells[ref(2, opHeaderRow)] = "SAM";
  cells[ref(3, opHeaderRow)] = "Cost Per Mint";
  cells[ref(4, opHeaderRow)] = "CMP";
  [0, 1, 2, 3, 4].forEach((c) => { styles[ref(c, opHeaderRow)] = HEAD_STYLE; });
  r += 1;
  const opDataRow = r;
  cells[ref(0, opDataRow)] = "1";
  cells[ref(4, opDataRow)] = `=${ref(2, opDataRow)}*${ref(3, opDataRow)}`;
  const cmpTotalRef = ref(4, opDataRow);
  r += 2;

  // ── Total FOB cost — raw materials + CMP ──────────────────────────────
  cells[ref(0, r)] = "Total FOB Cost";
  styles[ref(0, r)] = TITLE_STYLE;
  cells[ref(4, r)] = `=${rawMaterialsLineRef}+${cmpTotalRef}`;
  styles[ref(4, r)] = TITLE_STYLE;

  return { id: "sheet-2", name: "Inquiry Costing", cells, styles, rows: 200, cols: 26 };
}

/**
 * The merchandiser's standalone workbook — context + the raw-items BOM.
 *
 * @param {object} p
 * @param {{enquiryId?:string, customerName?:string, accountName?:string, enquiryDate?:string|Date}} p.enquiry
 * @param {object} p.product
 * @returns {{sheets: object[], activeId: string}}
 */
function buildRawMaterialsWorkbook({ enquiry, product }) {
  const { rawMaterialTotalRef, ...sheet } = buildRawItemsSheet({ enquiry, product });
  return { sheets: [sheet], activeId: sheet.id };
}

/**
 * The industrial engineer's standalone workbook — context + operations.
 *
 * @param {object} p
 * @param {{enquiryId?:string, customerName?:string, accountName?:string, enquiryDate?:string|Date}} p.enquiry
 * @param {object} p.product
 * @returns {{sheets: object[], activeId: string}}
 */
function buildOperationsWorkbook({ enquiry, product }) {
  const sheet = buildOperationsSheet({ enquiry, product });
  return { sheets: [sheet], activeId: sheet.id };
}

/**
 * The original combined two-tab workbook.
 *
 * Kept because the costings created before the split are real CoWork documents
 * people still have open — the CMS has to keep reading and writing them in the
 * shape they were made in. Nothing creates a new one.
 *
 * @param {object} p
 * @param {{enquiryId?:string, customerName?:string, accountName?:string, enquiryDate?:string|Date}} p.enquiry
 * @param {object} p.product
 * @returns {{sheets: object[], activeId: string}} a Workbook, ready to
 *   JSON.stringify into cowork_document_bodies/{id}.cells.
 */
function buildCostingWorkbook({ enquiry, product }) {
  const rawItemsSheet = buildRawItemsSheet();
  const { rawMaterialTotalRef, ...sheetOneClean } = rawItemsSheet;
  const summarySheet = buildCostingSummarySheet({
    enquiry,
    product,
    rawMaterialTotalRef,
    sheetOneName: rawItemsSheet.name,
  });

  return {
    sheets: [sheetOneClean, summarySheet],
    activeId: summarySheet.id,
  };
}

module.exports = {
  buildCostingWorkbook,
  buildRawMaterialsWorkbook,
  buildOperationsWorkbook,
  RAW_ITEM_CATEGORIES,
};

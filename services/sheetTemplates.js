// services/sheetTemplates.js
//
// Builds the pre-filled cell content for a new costing sheet, in the exact
// JSON shape CoWork's own sheet grid reads and writes (Cowork/lib/rules/
// sheets/grid.ts — Workbook / SheetTab / CellMap). Nothing here talks to
// Firestore; it only produces the object services/coworkSheets.service.js's
// createSheet() JSON.stringifies into cowork_document_bodies/{id}.cells.
//
// Format follows the "BOM Inquiry Cost" workbook supplied as the reference —
// two tabs: a raw-items BOM (filled in during costing) and an Inquiry
// Costing summary (buyer/product info known today, pre-filled; costs filled
// in as the BOM is worked out). Only the STRUCTURE is templated — category
// rows, headers, formulas — never the reference file's own example vendor
// rows, which belonged to a different, unrelated product.
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

function buildRawItemsSheet() {
  const cells = {};
  const styles = {};

  cells[ref(0, 1)] = "Raw Items Details";
  styles[ref(0, 1)] = TITLE_STYLE;

  const headerRow = 3;
  const headers = ["Sl no", "Category", "Raw item", "Variant / Vendor", "Unit cost", "Consumption (with allowance)", "Total cost"];
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
    cells[ref(6, dataRow)] = `=${ref(4, dataRow)}*${ref(5, dataRow)}`;
    totalCostCells.push(ref(6, dataRow));
    row += 1;
  }

  row += 1;
  cells[ref(1, row)] = "Total Raw Material Cost";
  styles[ref(1, row)] = HEAD_STYLE;
  cells[ref(6, row)] = `=SUM(${totalCostCells[0]}:${totalCostCells[totalCostCells.length - 1]})`;
  styles[ref(6, row)] = HEAD_STYLE;
  const rawMaterialTotalRef = ref(6, row);

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

function buildCostingSummarySheet({ enquiry, product, rawMaterialTotalRef, sheetOneName }) {
  const cells = {};
  const styles = {};

  cells[ref(0, 1)] = "Grav Clothing Pvt Ltd";
  styles[ref(0, 1)] = TITLE_STYLE;
  cells[ref(0, 2)] = "Inquiry Costing";
  styles[ref(0, 2)] = HEAD_STYLE;

  // ── Buyer info — known the moment an enquiry exists ──────────────────
  let r = 4;
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
 * Build the full two-tab costing workbook for one enquiry product.
 *
 * @param {object} p
 * @param {{enquiryId?:string, customerName?:string, accountName?:string, enquiryDate?:string|Date}} p.enquiry
 * @param {{product?:string, quantity?:number, gender?:string, colour?:string,
 *   fabricPreference?:string, fabricComposition?:string, gsm?:string,
 *   fit?:string, sizeRange?:string, trims?:string, logo?:boolean,
 *   embroidery?:boolean, printing?:boolean, brandingPlacement?:string,
 *   specialConstruction?:string}} p.product
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

module.exports = { buildCostingWorkbook };

// services/tallyParser.service.js
// =============================================================================
// TALLY FILE PARSER
// -----------------------------------------------------------------------------
// Reads an uploaded file (.xlsx, .xls, .csv, .xml) and returns a unified
// shape: { columns, rows, sheets, meta }.
//
// We parse PASSIVELY — no DB writes happen here. The route layer takes the
// parsed result, runs it through `tallyMapper.service.js` to produce model
// instances, then persists.
// =============================================================================

const XLSX = require("xlsx");
const { parseStringPromise } = require("xml2js");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @param {Buffer|string} input – file buffer or path
 * @param {object} options – { fileType, sheetName, hasHeaders, headerRow }
 * @returns {Promise<{ columns: string[], rows: object[], sheets: string[],
 *                     activeSheet: string, totalRows: number, meta: object }>}
 */
async function parseFile(input, options = {}) {
  const fileType = (options.fileType || "").toLowerCase();
  if (!fileType) throw new Error("fileType is required (xlsx | xls | csv | xml | json)");

  const buffer = Buffer.isBuffer(input) ? input : fs.readFileSync(input);

  switch (fileType) {
    case "xlsx":
    case "xls":
      return parseExcel(buffer, options);
    case "csv":
      return parseCSV(buffer, options);
    case "xml":
      return parseXML(buffer, options);
    case "json":
      return parseJSON(buffer, options);
    default:
      throw new Error(`Unsupported file type: ${fileType}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Excel (.xlsx, .xls)
// ─────────────────────────────────────────────────────────────────────────────
function parseExcel(buffer, opts = {}) {
  const wb = XLSX.read(buffer, { type: "buffer", cellDates: true, cellNF: false, cellText: false });
  const sheets = wb.SheetNames;
  const activeSheet = opts.sheetName && sheets.includes(opts.sheetName) ? opts.sheetName : sheets[0];
  const ws = wb.Sheets[activeSheet];

  // sheet_to_json with header:1 gives us a 2D array — keeps the header row
  // explicit and lets us deal with quirky Tally exports (merged headers,
  // metadata rows, etc.)
  const matrix = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "", raw: false, blankrows: false });

  return shapeMatrix(matrix, { ...opts, activeSheet, sheets });
}

// ─────────────────────────────────────────────────────────────────────────────
// CSV
// ─────────────────────────────────────────────────────────────────────────────
function parseCSV(buffer, opts = {}) {
  const text = buffer.toString("utf8").replace(/^\uFEFF/, ""); // strip BOM
  const delimiter = opts.delimiter || detectDelimiter(text) || ",";

  // Quick-and-correct CSV: handle quoted fields, embedded delimiters, escaped quotes.
  const matrix = parseCSVText(text, delimiter);
  return shapeMatrix(matrix, { ...opts, activeSheet: "csv", sheets: ["csv"] });
}

function detectDelimiter(text) {
  const firstLine = text.split(/\r?\n/)[0] || "";
  const counts = { ",": (firstLine.match(/,/g) || []).length,
                   ";": (firstLine.match(/;/g) || []).length,
                   "\t": (firstLine.match(/\t/g) || []).length,
                   "|": (firstLine.match(/\|/g) || []).length };
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
}

function parseCSVText(text, delimiter) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (inQuotes) {
      if (c === '"' && next === '"') { field += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === delimiter) { row.push(field); field = ""; }
      else if (c === "\r") { /* skip */ }
      else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
      else field += c;
    }
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(v => v !== ""));
}

// ─────────────────────────────────────────────────────────────────────────────
// XML — Tally's native format
// ─────────────────────────────────────────────────────────────────────────────
//
// Tally XML structure (simplified):
//   <ENVELOPE>
//     <BODY>
//       <IMPORTDATA>
//         <REQUESTDATA>
//           <TALLYMESSAGE>
//             <VOUCHER VCHTYPE="Sales" ACTION="Create">
//               <DATE>20250401</DATE>
//               <VOUCHERNUMBER>1</VOUCHERNUMBER>
//               <PARTYLEDGERNAME>Acme Corp</PARTYLEDGERNAME>
//               <ALLLEDGERENTRIES.LIST> ... </ALLLEDGERENTRIES.LIST>
//               <INVENTORYENTRIES.LIST> ... </INVENTORYENTRIES.LIST>
//             </VOUCHER>
//           </TALLYMESSAGE>
//           ...
async function parseXML(buffer, opts = {}) {
  const xml = buffer.toString("utf8");
  const parsed = await parseStringPromise(xml, {
    explicitArray: false,
    mergeAttrs: true,
    trim: true,
    normalize: true,
  });

  // Walk to ENVELOPE.BODY.IMPORTDATA.REQUESTDATA.TALLYMESSAGE
  const envelope = parsed.ENVELOPE || parsed.envelope || parsed;
  const body = envelope.BODY || envelope.Body || envelope.body || envelope;

  const tallyMessages = extractTallyMessages(body);
  const rows = [];
  const columns = new Set();

  for (const msg of tallyMessages) {
    if (msg.VOUCHER) {
      const v = Array.isArray(msg.VOUCHER) ? msg.VOUCHER : [msg.VOUCHER];
      for (const voucher of v) {
        const flat = flattenVoucherXML(voucher);
        Object.keys(flat).forEach(k => columns.add(k));
        rows.push(flat);
      }
    }
    if (msg.LEDGER) {
      const l = Array.isArray(msg.LEDGER) ? msg.LEDGER : [msg.LEDGER];
      for (const ledger of l) {
        const flat = flattenLedgerXML(ledger);
        Object.keys(flat).forEach(k => columns.add(k));
        rows.push(flat);
      }
    }
    if (msg.STOCKITEM) {
      const s = Array.isArray(msg.STOCKITEM) ? msg.STOCKITEM : [msg.STOCKITEM];
      for (const item of s) {
        const flat = flattenStockItemXML(item);
        Object.keys(flat).forEach(k => columns.add(k));
        rows.push(flat);
      }
    }
    if (msg.GROUP) {
      const g = Array.isArray(msg.GROUP) ? msg.GROUP : [msg.GROUP];
      for (const grp of g) {
        const flat = flattenGroupXML(grp);
        Object.keys(flat).forEach(k => columns.add(k));
        rows.push(flat);
      }
    }
  }

  return {
    columns: Array.from(columns),
    rows,
    sheets: ["xml"],
    activeSheet: "xml",
    totalRows: rows.length,
    meta: { source: "xml", tallyVersion: detectTallyVersion(envelope) },
  };
}

function extractTallyMessages(body) {
  const importData = body.IMPORTDATA || body.importdata;
  if (!importData) return [];
  const reqData = importData.REQUESTDATA || importData.requestdata;
  if (!reqData) return [];
  const msgs = reqData.TALLYMESSAGE || reqData.tallymessage;
  if (!msgs) return [];
  return Array.isArray(msgs) ? msgs : [msgs];
}

function detectTallyVersion(envelope) {
  if (envelope?.HEADER?.VERSION) return envelope.HEADER.VERSION;
  return "unknown";
}

function flattenVoucherXML(v) {
  const ledgerLines = v["ALLLEDGERENTRIES.LIST"] || v.ALLLEDGERENTRIESLIST || [];
  const inventoryLines = v["ALLINVENTORYENTRIES.LIST"] || v["INVENTORYENTRIES.LIST"] || [];

  return {
    __type: "voucher",
    VCHTYPE: v.VCHTYPE || "",
    DATE: parseTallyDate(v.DATE),
    VOUCHERNUMBER: v.VOUCHERNUMBER || "",
    REFERENCE: v.REFERENCE || "",
    REFERENCEDATE: parseTallyDate(v.REFERENCEDATE),
    PARTYLEDGERNAME: v.PARTYLEDGERNAME || v.PARTYNAME || "",
    NARRATION: v.NARRATION || "",
    GUID: v.GUID || "",
    ledgerEntries: normaliseList(ledgerLines).map(l => ({
      LEDGERNAME: l.LEDGERNAME || "",
      AMOUNT: parseTallyAmount(l.AMOUNT),
      ISDEEMEDPOSITIVE: (l.ISDEEMEDPOSITIVE || "").toUpperCase() === "YES",
    })),
    inventoryEntries: normaliseList(inventoryLines).map(i => ({
      STOCKITEMNAME: i.STOCKITEMNAME || "",
      ACTUALQTY: i.ACTUALQTY || "",
      RATE: i.RATE || "",
      AMOUNT: parseTallyAmount(i.AMOUNT),
    })),
  };
}

function flattenLedgerXML(l) {
  return {
    __type: "ledger",
    NAME: (l.NAME || l["LANGUAGENAME.LIST"]?.["NAME.LIST"]?.NAME) || "",
    PARENT: l.PARENT || "",
    OPENINGBALANCE: parseTallyAmount(l.OPENINGBALANCE),
    GSTREGISTRATIONTYPE: l.GSTREGISTRATIONTYPE || "",
    PARTYGSTIN: l.PARTYGSTIN || "",
    INCOMETAXNUMBER: l.INCOMETAXNUMBER || "",
    GUID: l.GUID || "",
    EMAIL: l.EMAIL || "",
    LEDGERPHONE: l.LEDGERPHONE || l.LEDMOBILE || "",
    LEDGERMAILINGADDRESS: l.LEDGERMAILINGADDRESS || "",
    BILLCREDITPERIOD: l.BILLCREDITPERIOD || "",
    AFFECTSSTOCK: l.AFFECTSSTOCK || "No",
    ISBILLWISEON: (l.ISBILLWISEON || "").toUpperCase() === "YES",
  };
}

function flattenStockItemXML(s) {
  return {
    __type: "stock_item",
    NAME: s.NAME || "",
    PARENT: s.PARENT || "",
    BASEUNITS: s.BASEUNITS || "",
    GSTAPPLICABLE: s.GSTAPPLICABLE || "",
    HSNCODE: s.HSNCODE || s.GSTHSNCODE || "",
    OPENINGBALANCE: s.OPENINGBALANCE || "",
    OPENINGVALUE: parseTallyAmount(s.OPENINGVALUE),
    OPENINGRATE: s.OPENINGRATE || "",
    GUID: s.GUID || "",
  };
}

function flattenGroupXML(g) {
  return {
    __type: "group",
    NAME: g.NAME || "",
    PARENT: g.PARENT || "",
    NATURE: g.PRIMARYGROUP || g.NATURE || "",
    GUID: g.GUID || "",
  };
}

function normaliseList(x) {
  if (!x) return [];
  if (Array.isArray(x)) return x;
  return [x];
}

// Tally dates: "20250401" → "2025-04-01"
function parseTallyDate(d) {
  if (!d) return null;
  const s = String(d).trim();
  if (/^\d{8}$/.test(s)) {
    return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  }
  return s;
}

// Tally amounts can be "-1500.00", "1500.00 Cr", "1500.00 Dr", "(1500.00)"
function parseTallyAmount(a) {
  if (a === undefined || a === null || a === "") return 0;
  const s = String(a).trim();
  let neg = false;
  let n = s;
  if (/^\(.+\)$/.test(s)) { neg = true; n = s.slice(1, -1); }
  if (/Cr\s*$/i.test(n)) { neg = true; n = n.replace(/Cr\s*$/i, "").trim(); }
  if (/Dr\s*$/i.test(n)) { n = n.replace(/Dr\s*$/i, "").trim(); }
  n = n.replace(/[^\d.\-]/g, "");
  const v = parseFloat(n);
  if (isNaN(v)) return 0;
  return neg ? -Math.abs(v) : v;
}

// ─────────────────────────────────────────────────────────────────────────────
// JSON
// ─────────────────────────────────────────────────────────────────────────────
async function parseJSON(buffer, opts = {}) {
  const text = buffer.toString("utf8");
  const data = JSON.parse(text);
  const arr = Array.isArray(data) ? data : (data.rows || data.data || [data]);
  const columns = new Set();
  arr.forEach(r => Object.keys(r).forEach(k => columns.add(k)));
  return {
    columns: Array.from(columns),
    rows: arr,
    sheets: ["json"],
    activeSheet: "json",
    totalRows: arr.length,
    meta: { source: "json" },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Common matrix → object[] shaper (used by Excel + CSV)
// ─────────────────────────────────────────────────────────────────────────────
function shapeMatrix(matrix, opts = {}) {
  const hasHeaders = opts.hasHeaders !== false;
  const headerRow  = (opts.headerRow || 1) - 1;        // 0-indexed
  const dataStart  = (opts.dataStartRow || (hasHeaders ? 2 : 1)) - 1;

  // Skip leading blank/metadata rows automatically — Tally exports often
  // include a "Company name" / "Period" preamble.
  let effectiveHeaderRow = headerRow;
  if (hasHeaders) {
    while (effectiveHeaderRow < matrix.length) {
      const r = matrix[effectiveHeaderRow] || [];
      if (r.filter(c => c !== "").length >= 2) break;
      effectiveHeaderRow++;
    }
  }

  const columns = hasHeaders
    ? (matrix[effectiveHeaderRow] || []).map((c, i) => (String(c || `col_${i + 1}`).trim() || `col_${i + 1}`))
    : ((matrix[0] || []).map((_, i) => `col_${i + 1}`));

  // De-duplicate column names — Tally sometimes has e.g. two "Amount" columns
  const seen = {};
  const uniqColumns = columns.map(c => {
    if (seen[c]) {
      seen[c]++;
      return `${c}_${seen[c]}`;
    }
    seen[c] = 1;
    return c;
  });

  const dataRows = matrix.slice(hasHeaders ? Math.max(dataStart, effectiveHeaderRow + 1) : 0);
  const rows = dataRows
    .filter(r => r.some(v => v !== ""))
    .map((r) => {
      const obj = {};
      uniqColumns.forEach((c, i) => { obj[c] = r[i] !== undefined ? r[i] : ""; });
      return obj;
    });

  return {
    columns: uniqColumns,
    rows,
    sheets: opts.sheets || [opts.activeSheet || "sheet1"],
    activeSheet: opts.activeSheet || "sheet1",
    totalRows: rows.length,
    meta: { source: "matrix", headerRowDetected: effectiveHeaderRow + 1 },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Auto-detect entity type from headers
// ─────────────────────────────────────────────────────────────────────────────
//
// Tally's standard exports have very characteristic column sets. We sniff
// headers to suggest the most likely entityType — saves the user a click.
const ENTITY_SIGNATURES = {
  voucher_sales: ["voucher type", "voucher number", "voucher date", "party", "amount", "sales"],
  voucher_purchase: ["voucher type", "voucher number", "voucher date", "party", "amount", "purchase"],
  voucher_payment: ["voucher type", "payment", "amount", "date"],
  voucher_receipt: ["voucher type", "receipt", "amount", "date"],
  voucher_journal: ["voucher type", "journal", "debit", "credit"],
  ledger:        ["ledger name", "group", "opening balance", "gstin", "address"],
  stock_item:    ["stock item", "unit", "hsn", "opening", "rate"],
  group:         ["group name", "parent", "nature"],
  cost_centre:   ["cost centre", "category", "parent"],
};

function detectEntityType(columns) {
  const cols = columns.map(c => String(c).toLowerCase().trim());
  let best = { type: null, score: 0 };
  for (const [type, keywords] of Object.entries(ENTITY_SIGNATURES)) {
    const score = keywords.reduce((s, k) => s + (cols.some(c => c.includes(k)) ? 1 : 0), 0);
    if (score > best.score) best = { type, score };
  }
  return best.score >= 2 ? best.type : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// File checksum (dedupe protection)
// ─────────────────────────────────────────────────────────────────────────────
function fileChecksum(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

module.exports = {
  parseFile,
  parseExcel,
  parseCSV,
  parseXML,
  parseJSON,
  detectEntityType,
  parseTallyDate,
  parseTallyAmount,
  fileChecksum,
};

// services/tallyMapper.service.js
// =============================================================================
// TALLY FIELD MAPPER
// -----------------------------------------------------------------------------
// Takes the output of `tallyParser.service.js` (rows + columns) plus a
// FieldMapping template, and produces validated payloads ready to write to
// the corresponding Tally* model.
//
// Two modes:
//   1. SINGLE-ROW   – one row in source = one entity (typical for ledger
//                     master imports, simple voucher exports).
//   2. MULTI-ROW    – multiple source rows that share a `groupByColumn`
//                     value get folded into a single voucher with multiple
//                     ledger entries (Tally's "Ledger Details from Multiple
//                     Rows" mapping mode).
// =============================================================================

const { Acc_Ledger, Acc_Group } = require("../models/Accountant_model/Acc_MasterModels");

// ─────────────────────────────────────────────────────────────────────────────
// Transforms — small DSL referenced by the mapping
// ─────────────────────────────────────────────────────────────────────────────
const TRANSFORMS = {
  none:     (v) => v,
  uppercase:(v) => (v == null ? v : String(v).toUpperCase()),
  lowercase:(v) => (v == null ? v : String(v).toLowerCase()),
  trim:     (v) => (v == null ? v : String(v).trim()),
  split_first:(v) => (v == null ? v : String(v).split(/[\/\-\s]/)[0]),
  split_last: (v) => {
    if (v == null) return v;
    const parts = String(v).split(/[\/\-\s]/);
    return parts[parts.length - 1];
  },
  abs:      (v) => Math.abs(parseFloatSafe(v)),
  negate:   (v) => -parseFloatSafe(v),
  parse_indian_currency: (v) => parseIndianCurrency(v),
  // Tally writes "1500.00 Cr" / "1500.00 Dr" — split into { amount, type }
  parse_dr_cr_suffix: (v) => {
    if (v == null) return { amount: 0, type: "Dr" };
    const s = String(v).trim();
    const m = s.match(/^([\d,.\-]+)\s*(Dr|Cr)?\s*$/i);
    if (!m) return { amount: parseFloatSafe(v), type: "Dr" };
    return { amount: Math.abs(parseFloatSafe(m[1])), type: (m[2] || "Dr").toUpperCase() === "CR" ? "Cr" : "Dr" };
  },
};

function parseFloatSafe(v) {
  if (v == null || v === "") return 0;
  const n = parseFloat(String(v).replace(/[^\d.\-]/g, ""));
  return isNaN(n) ? 0 : n;
}

function parseIndianCurrency(v) {
  if (v == null || v === "") return 0;
  const s = String(v).replace(/[₹\s,]/g, "");
  return parseFloatSafe(s);
}

// ─────────────────────────────────────────────────────────────────────────────
// Date parsing — handles the formats Tally exports + a few common variants
// ─────────────────────────────────────────────────────────────────────────────
function parseDate(v, fmtHint = "DD-MM-YYYY") {
  if (v == null || v === "") return null;
  if (v instanceof Date && !isNaN(v)) return v;

  // Excel may return a JS Date directly when cellDates:true; we already have it.
  const s = String(v).trim();

  // 8-digit Tally date "YYYYMMDD"
  if (/^\d{8}$/.test(s)) {
    const d = new Date(`${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}`);
    return isNaN(d) ? null : d;
  }

  // ISO
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const d = new Date(s);
    return isNaN(d) ? null : d;
  }

  // DD-MM-YYYY / DD/MM/YYYY (Indian default)
  const m1 = s.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})$/);
  if (m1) {
    let [, dd, mm, yy] = m1;
    if (yy.length === 2) yy = `20${yy}`;
    // Honour the hint — accountants sometimes upload US-format files
    const isUS = fmtHint.startsWith("MM");
    const d = new Date(`${yy}-${(isUS ? dd : mm).padStart(2, "0")}-${(isUS ? mm : dd).padStart(2, "0")}`);
    return isNaN(d) ? null : d;
  }

  const fallback = new Date(s);
  return isNaN(fallback) ? null : fallback;
}

// ─────────────────────────────────────────────────────────────────────────────
// Type coercion per `dataType` declared in the mapping
// ─────────────────────────────────────────────────────────────────────────────
function coerce(value, dataType, opts = {}) {
  if (value === undefined || value === null || value === "") {
    return opts.defaultValue !== undefined ? opts.defaultValue : null;
  }

  switch (dataType) {
    case "string":   return String(value).trim();
    case "number":   return parseFloatSafe(value);
    case "currency": return parseIndianCurrency(value);
    case "date":     return parseDate(value, opts.dateFormat);
    case "boolean":  {
      const s = String(value).toLowerCase().trim();
      return ["yes", "y", "true", "1"].includes(s);
    }
    case "dr_cr": {
      const s = String(value).trim().toLowerCase();
      if (["dr", "debit", "d"].includes(s)) return "Dr";
      if (["cr", "credit", "c"].includes(s)) return "Cr";
      return parseFloatSafe(value) >= 0 ? "Dr" : "Cr";
    }
    case "ledger_ref": return String(value).trim(); // resolved later in resolver
    case "stock_ref":  return String(value).trim();
    default: return value;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Apply mapping to a single row
// ─────────────────────────────────────────────────────────────────────────────
function applyMapping(row, mapping, fileShape = {}) {
  const out = {};
  const errors = [];

  for (const m of mapping.mappings) {
    const raw = row[m.sourceColumn];
    let value = raw;

    // Apply transform
    if (m.transform && TRANSFORMS[m.transform]) {
      value = TRANSFORMS[m.transform](value);
    }

    // Coerce to declared type
    value = coerce(value, m.dataType, {
      defaultValue: m.defaultValue,
      dateFormat: fileShape.dateFormat,
    });

    if (m.required && (value === null || value === "" || value === undefined)) {
      errors.push({ field: m.targetField, message: `Required field "${m.targetField}" is missing (column: ${m.sourceColumn})` });
    }

    // Set on output using dot-path support
    setByPath(out, m.targetField, value);
  }

  return { data: out, errors };
}

function setByPath(obj, path, value) {
  const parts = path.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    cur[parts[i]] = cur[parts[i]] || {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

// ─────────────────────────────────────────────────────────────────────────────
// Multi-row voucher folding
// ─────────────────────────────────────────────────────────────────────────────
function foldMultiRow(rows, mapping, fileShape = {}) {
  const groupCol = mapping.multiRowRule?.groupByColumn;
  if (!groupCol) {
    // Fall back to single-row mode
    return rows.map((r, i) => ({ ...applyMapping(r, mapping, fileShape), rowNumber: i + 1 }));
  }

  // Group rows by `groupCol`
  const groups = new Map();
  rows.forEach((r, idx) => {
    const key = String(r[groupCol] || "").trim();
    if (!key) return;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ row: r, idx: idx + 1 });
  });

  const results = [];
  for (const [groupKey, members] of groups.entries()) {
    const head = applyMapping(members[0].row, mapping, fileShape);

    // Each member becomes one ledger entry
    const ledgerEntries = members.map(({ row }) => {
      const partial = applyMapping(row, mapping, fileShape);
      const e = partial.data || {};
      // ledgerEntry shape from the mapping: ledgerName, type (Dr/Cr), amount
      const le = {
        ledgerName: e.ledgerName || row.LedgerName || row["Ledger Name"] || "",
        type:       e.type || (parseFloatSafe(e.amount) >= 0 ? "Dr" : "Cr"),
        amount:     Math.abs(parseFloatSafe(e.amount)),
        narration:  e.narration || "",
      };
      return le;
    });

    head.data.ledgerEntries = ledgerEntries;
    head.rowNumber = members[0].idx;
    head.groupKey  = groupKey;
    head.groupedRowCount = members.length;
    results.push(head);
  }
  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// Ledger resolver — given a ledger name, find or auto-create the doc
// ─────────────────────────────────────────────────────────────────────────────
//
// Tally is name-based (no GUIDs in user data), so all our voucher entries
// reference ledgers BY NAME. We resolve names to ObjectIds, optionally
// auto-creating missing ledgers under the configured default group.
async function resolveLedgers(names, companyId, opts = {}) {
  const unique = Array.from(new Set(names.map(n => String(n || "").trim()).filter(Boolean)));
  if (!unique.length) return new Map();

  // 1. Existing ledgers (case-insensitive on name OR aliases)
  const existing = await Acc_Ledger.find({
    companyId,
    $or: [
      { name: { $in: unique.map(n => new RegExp(`^${escapeRegex(n)}$`, "i")) } },
      { aliases: { $in: unique } },
    ],
  }).lean();

  const map = new Map();
  for (const l of existing) {
    map.set(l.name.toLowerCase(), l);
    (l.aliases || []).forEach(a => map.set(a.toLowerCase(), l));
  }

  // 2. Auto-create the missing ones if allowed
  const missing = unique.filter(n => !map.has(n.toLowerCase()));
  if (missing.length && opts.autoCreate) {
    const defaultGroupName = opts.defaultGroup || "Sundry Debtors";
    const group = await Acc_Group.findOne({ companyId, name: defaultGroupName }).lean();
    if (!group) {
      throw new Error(`Default group "${defaultGroupName}" not found — seed Tally groups first.`);
    }
    const created = await Acc_Ledger.insertMany(missing.map(n => ({
      companyId,
      name: n,
      groupId: group._id,
      groupName: group.name,
      nature: group.nature,
      openingBalance: 0,
      currentBalance: 0,
      importSource: opts.importSource || "auto",
      importedAt: new Date(),
      createdBy: opts.createdBy,
    })));
    created.forEach(l => map.set(l.name.toLowerCase(), l));
  }

  return map;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ─────────────────────────────────────────────────────────────────────────────
// CMS bridge — try to link a Tally ledger to an existing GRAV Customer/Vendor
// by name match
// ─────────────────────────────────────────────────────────────────────────────
async function autoLinkLedgersToCMS(ledgers, models = {}) {
  const Customer = models.Customer;
  const Vendor   = models.Vendor;
  const summary  = { customersLinked: 0, vendorsLinked: 0 };

  for (const ledger of ledgers) {
    if (ledger.linkedCustomerId || ledger.linkedVendorId) continue;
    const name = (ledger.name || "").trim();
    if (!name) continue;

    // Sundry Debtors → match against Customer
    if (Customer && /sundry debtor|debtor|customer/i.test(ledger.groupName || "")) {
      const cust = await Customer.findOne({
        $or: [
          { name: new RegExp(`^${escapeRegex(name)}$`, "i") },
          { "profile.companyName": new RegExp(`^${escapeRegex(name)}$`, "i") },
        ],
      }).select("_id name").lean();
      if (cust) {
        await ledger.constructor.updateOne({ _id: ledger._id }, { linkedCustomerId: cust._id });
        summary.customersLinked++;
      }
    }
    // Sundry Creditors → match against Vendor
    if (Vendor && /sundry creditor|creditor|vendor|supplier/i.test(ledger.groupName || "")) {
      const vend = await Vendor.findOne({
        $or: [
          { name: new RegExp(`^${escapeRegex(name)}$`, "i") },
          { companyName: new RegExp(`^${escapeRegex(name)}$`, "i") },
        ],
      }).select("_id name").lean();
      if (vend) {
        await ledger.constructor.updateOne({ _id: ledger._id }, { linkedVendorId: vend._id });
        summary.vendorsLinked++;
      }
    }
  }

  return summary;
}

// ─────────────────────────────────────────────────────────────────────────────
// Suggested mapping — given detected columns, propose a mapping for the
// chosen entity type. Uses fuzzy match on common Tally header names.
// ─────────────────────────────────────────────────────────────────────────────
const FIELD_HINTS = {
  voucher_sales: [
    { target: "voucherDate",      hints: ["voucher date", "date"], dataType: "date", required: true },
    { target: "voucherNumber",    hints: ["voucher number", "voucher no", "vch no", "invoice no", "bill no"], dataType: "string", required: true },
    { target: "voucherTypeName",  hints: ["voucher type", "vch type"], dataType: "string" },
    { target: "partyLedgerName",  hints: ["party", "party name", "ledger", "customer"], dataType: "string" },
    { target: "narration",        hints: ["narration", "description", "particulars"], dataType: "string" },
    { target: "grandTotal",       hints: ["grand total", "amount", "total", "net amount", "invoice amount"], dataType: "currency" },
    { target: "gstBreakup.cgst",  hints: ["cgst"], dataType: "currency" },
    { target: "gstBreakup.sgst",  hints: ["sgst"], dataType: "currency" },
    { target: "gstBreakup.igst",  hints: ["igst"], dataType: "currency" },
    { target: "referenceNumber",  hints: ["reference", "ref no", "bill ref"], dataType: "string" },
  ],
  voucher_purchase: [
    { target: "voucherDate",      hints: ["voucher date", "date"], dataType: "date", required: true },
    { target: "voucherNumber",    hints: ["voucher number", "voucher no", "bill no", "invoice no"], dataType: "string", required: true },
    { target: "partyLedgerName",  hints: ["party", "supplier", "vendor", "ledger"], dataType: "string" },
    { target: "grandTotal",       hints: ["grand total", "amount", "total", "net amount"], dataType: "currency" },
    { target: "gstBreakup.cgst",  hints: ["cgst"], dataType: "currency" },
    { target: "gstBreakup.sgst",  hints: ["sgst"], dataType: "currency" },
    { target: "gstBreakup.igst",  hints: ["igst"], dataType: "currency" },
  ],
  ledger: [
    { target: "name",             hints: ["ledger name", "name", "particulars"], dataType: "string", required: true },
    { target: "groupName",        hints: ["group", "under", "parent"], dataType: "string", required: true },
    { target: "openingBalance",   hints: ["opening balance", "opening", "ob"], dataType: "currency" },
    { target: "gstin",            hints: ["gstin", "gst no", "gst number"], dataType: "string" },
    { target: "panNumber",        hints: ["pan", "pan no", "pan number"], dataType: "string" },
    { target: "contactDetails.email", hints: ["email", "e-mail"], dataType: "string" },
    { target: "contactDetails.phone", hints: ["phone", "mobile", "contact"], dataType: "string" },
    { target: "contactDetails.address", hints: ["address", "mailing address"], dataType: "string" },
  ],
  stock_item: [
    { target: "name",             hints: ["stock item", "item name", "name", "particulars"], dataType: "string", required: true },
    { target: "stockGroupName",   hints: ["stock group", "group", "under", "parent"], dataType: "string" },
    { target: "baseUnit",         hints: ["unit", "uom", "base unit"], dataType: "string" },
    { target: "hsnCode",          hints: ["hsn", "hsn code", "hsn/sac"], dataType: "string" },
    { target: "openingQuantity",  hints: ["opening quantity", "opening qty", "opening stock"], dataType: "number" },
    { target: "openingRate",      hints: ["opening rate", "rate"], dataType: "currency" },
    { target: "openingValue",     hints: ["opening value", "opening amount"], dataType: "currency" },
    { target: "taxRate",          hints: ["tax rate", "gst rate", "gst %"], dataType: "number" },
  ],
  group: [
    { target: "name",             hints: ["group name", "name"], dataType: "string", required: true },
    { target: "parentName",       hints: ["parent", "under"], dataType: "string" },
    { target: "nature",           hints: ["nature", "primary group"], dataType: "string" },
  ],
};

function suggestMapping(columns, entityType) {
  const hints = FIELD_HINTS[entityType] || [];
  const lowerCols = columns.map(c => ({ original: c, lc: String(c).toLowerCase().trim() }));
  const result = [];

  for (const h of hints) {
    let match = null;
    for (const c of lowerCols) {
      if (h.hints.some(hint => c.lc === hint || c.lc.includes(hint))) {
        match = c.original;
        break;
      }
    }
    if (match) {
      result.push({
        sourceColumn: match,
        targetField:  h.target,
        dataType:     h.dataType || "string",
        required:     h.required || false,
        transform:    "trim",
      });
    }
  }
  return result;
}

module.exports = {
  applyMapping,
  foldMultiRow,
  resolveLedgers,
  autoLinkLedgersToCMS,
  suggestMapping,
  TRANSFORMS,
  parseDate,
  parseFloatSafe,
  parseIndianCurrency,
};

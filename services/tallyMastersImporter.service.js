// services/tallyMastersImporter.service.js
//
// TALLY MASTERS JSON IMPORTER  (v3 — rewritten for the real export format)
// ─────────────────────────────────────────────────────────────────────────────
// Exported from: Gateway of Tally → Display More Reports → List of Accounts
//                → Alt+E → Format: JSON → Type of Masters: All Masters
//
// WHAT THE REAL FILE ACTUALLY LOOKS LIKE
// ──────────────────────────────────────
// (Verified against a real 3.4 MB GRAV export, May 2026.)
//
//   {
//     "tallymessage": [
//       { "metadata": { "type": "Currency", "name": "₹" }, ... },
//       { "metadata": { "type": "Group",    "name": "Current Assets" }, "parent": ... },
//       { "metadata": { "type": "Ledger",   "name": "ABC Ltd" },
//         "parent": "Sundry Creditors",
//         "openingbalance": "₹ 57956.00",
//         "billallocations": [ { "name": "BT/01", "openingbalance": "₹ 22748.00" } ],
//         "ledgstregdetails":  [ { "gstin": "21ADKPK5119P1ZC",
//                                  "gstregistrationtype": "Regular",
//                                  "placeofsupply": "Odisha" } ],
//         "ledmailingdetails": [ { "address": [ {"metadata":true,"type":"String"},
//                                                "JHOLA SAHI, CUTTACK-753001" ],
//                                  "pincode": "753001", "state": "Odisha",
//                                  "country": "India" } ] }
//     ]
//   }
//
// KEY FACTS the previous parser got wrong (these broke the balance sheet on
// the real file):
//
//   1. `tallymessage` is a PROPER JSON ARRAY. There are NO duplicate keys.
//      `JSON.parse` works perfectly. The old brace-walker that searched for a
//      literal `{"metadata":{"type":"` mis-read this layout and produced
//      garbage totals. → We JSON.parse first; the brace-walker is only a
//      last-ditch fallback for genuinely malformed/truncated files.
//
//   2. The file also contains `Currency` objects (and may contain others).
//      Only Group + Ledger are imported; everything else is skipped quietly.
//
//   3. Opening balance: the TOP-LEVEL `openingbalance` is authoritative when
//      present (it is already the net signed figure). Only when it is
//      genuinely absent do we fall back to summing `billallocations`. The old
//      "if it parsed to 0, sum the bills" rule double-counted and corrupted
//      party balances.
//
//   4. Tally sign: leading "-" = Credit, no sign = Debit, relative to the
//      ledger's own natural side. We store magnitude + type and let the CoA /
//      Balance-Sheet layer apply nature.
//
//   5. `ledmailingdetails[].address` is a Tally "tagged string":
//      [ {metadata:true,type:"String"}, "line 1", "line 2", ... ]. Unwrap to
//      the joined human text.
//
//   6. Tally's 15 reserved primary groups carry NO `parent` — correct, they
//      ARE the roots. We still inject any missing reserved primaries so
//      nature resolution never dead-ends.
//
// IMPORTANT — this is a MASTERS export. It contains groups, ledgers and
// OPENING BALANCES only. It contains ZERO vouchers/invoices by design.
// Opening balances alone do NOT make a balanced Balance Sheet (the prior
// year's P&L / transaction history is not in a masters file). To import
// transactions, use the Tally *Day Book* / Balance-Sheet drill-down export
// (tallyBSheetImporter.service.js), not this one.
//
// API:
//   parseMastersJson(buffer) → { groups, ledgers, stats }
//   group  = { name, parent, nature, isPrimary }
//   ledger = { name, parent, openingBalance, openingBalanceType,
//              gstin, gstRegistrationType, placeOfSupply, address, pincode,
//              state, country, isGstApplicable, nature }

// ─── Encoding ───────────────────────────────────────────────────────────────

function decodeBuffer(buffer) {
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);

  const attempts = [];

  // 1. UTF-16 LE with BOM (the real Tally format)
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    attempts.push(buffer.slice(2).toString("utf16le"));
  }
  // 2. UTF-16 BE with BOM
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    const swapped = Buffer.alloc(buffer.length - 2);
    for (let i = 2; i < buffer.length; i += 2) {
      if (i + 1 < buffer.length) {
        swapped[i - 2] = buffer[i + 1];
        swapped[i - 1] = buffer[i];
      }
    }
    attempts.push(swapped.toString("utf16le"));
  }
  // 3. UTF-16 LE without BOM (null bytes in odd positions)
  if (buffer.length >= 4 && buffer[1] === 0x00 && buffer[3] === 0x00) {
    attempts.push(buffer.toString("utf16le"));
  }
  // 4. UTF-8 with BOM
  if (
    buffer.length >= 3 &&
    buffer[0] === 0xef &&
    buffer[1] === 0xbb &&
    buffer[2] === 0xbf
  ) {
    attempts.push(buffer.slice(3).toString("utf8"));
  }
  // 5. Plain UTF-8
  attempts.push(buffer.toString("utf8"));

  const MARKER_RES = [
    /"\s*tallymessage\s*"/i,
    /"\s*metadata\s*"/i,
    /"\s*mlvbody\s*"/i,
    /"\s*mlvledbody\s*"/i,
  ];
  for (const text of attempts) {
    for (const re of MARKER_RES) {
      if (re.test(text)) return text;
    }
  }
  return attempts.find((t) => t && t.length > 0) || buffer.toString("utf8");
}

// ─── Object collection ──────────────────────────────────────────────────────
//
// PRIMARY: JSON.parse the whole text, then walk `tallymessage` (array or
// single object). This works on every real Tally export.
// FALLBACK: only if JSON.parse fails, a whitespace + key-order tolerant
// brace-walker so we still salvage what we can.

function collectObjects(text) {
  try {
    const root = JSON.parse(text);
    const out = [];
    const visit = (node) => {
      if (Array.isArray(node)) {
        for (const el of node) visit(el);
        return;
      }
      if (node && typeof node === "object") {
        const md = node.metadata;
        if (md && typeof md === "object" && typeof md.type === "string") {
          out.push({ type: md.type, parsed: node });
        }
      }
    };
    if (root && typeof root === "object") {
      if (root.tallymessage !== undefined) visit(root.tallymessage);
      if (root.body !== undefined) visit(root.body);
      if (root.data !== undefined) visit(root.data);
      if (out.length === 0) visit(root);
    }
    if (out.length > 0) return out;
  } catch (_) {
    /* fall through */
  }
  return braceWalkObjects(text);
}

function _matchBrace(text, openIdx) {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = openIdx; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function braceWalkObjects(text) {
  const objects = [];
  const seen = new Set();
  const keyRe = /"\s*metadata\s*"\s*:\s*\{/gi;
  let m;
  while ((m = keyRe.exec(text)) !== null) {
    let objStart = -1;
    let depth = 0;
    let inStr = false;
    for (let i = m.index - 1; i >= 0; i--) {
      const ch = text[i];
      if (ch === '"') {
        let bs = 0;
        let j = i - 1;
        while (j >= 0 && text[j] === "\\") {
          bs++;
          j--;
        }
        if (bs % 2 === 0) inStr = !inStr;
        continue;
      }
      if (inStr) continue;
      if (ch === "}") depth++;
      else if (ch === "{") {
        if (depth === 0) {
          objStart = i;
          break;
        }
        depth--;
      }
    }
    if (objStart < 0 || seen.has(objStart)) continue;
    seen.add(objStart);
    const objEnd = _matchBrace(text, objStart);
    if (objEnd < 0) continue;
    let parsed;
    try {
      parsed = JSON.parse(text.slice(objStart, objEnd + 1));
    } catch {
      continue;
    }
    const md = parsed && parsed.metadata;
    if (!md || typeof md !== "object" || typeof md.type !== "string") continue;
    objects.push({ type: md.type, parsed });
  }
  return objects;
}

// ─── Value helpers ──────────────────────────────────────────────────────────

function unwrapTaggedString(v) {
  if (Array.isArray(v)) {
    const parts = [];
    for (const el of v) {
      if (typeof el === "string") {
        const s = el.replace(/^\u0004\s*/, "").trim();
        if (s) parts.push(s);
      }
    }
    return parts.join(", ");
  }
  if (typeof v === "string") return v.replace(/^\u0004\s*/, "").trim();
  return v == null ? "" : String(v);
}

function parseTallyNumber(s) {
  if (s == null || s === "") return 0;
  const str = String(s).trim();
  const isNeg = str.startsWith("-") || /(^|[^0-9])-\s*₹/.test(str);
  const cleaned = str.replace(/[^0-9.]/g, "");
  const n = parseFloat(cleaned);
  if (!Number.isFinite(n)) return 0;
  return isNeg ? -Math.abs(n) : n;
}

// ─── Group nature resolution ────────────────────────────────────────────────

const PRIMARY_NATURE = {
  "capital account": "equity",
  "loans (liability)": "liability",
  "current liabilities": "liability",
  "fixed assets": "asset",
  investments: "asset",
  "current assets": "asset",
  "branch / divisions": "asset",
  "misc. expenses (asset)": "asset",
  "suspense a/c": "asset",
  primary: "equity",
  "sales accounts": "revenue",
  "direct incomes": "revenue",
  "indirect incomes": "revenue",
  "purchase accounts": "expense",
  "direct expenses": "expense",
  "indirect expenses": "expense",
};

function resolveNature(groupName, groupParentMap) {
  let cur = (groupName || "").toLowerCase();
  const seen = new Set();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    if (PRIMARY_NATURE[cur]) return PRIMARY_NATURE[cur];
    const parent = groupParentMap.get(cur);
    if (!parent) break;
    cur = parent.toLowerCase();
  }
  return "asset";
}

const SYSTEM_LEDGER_GROUPS = {
  "profit & loss a/c": "Primary",
  "stock summary": "Stock-in-Hand",
  cash: "Cash-in-Hand",
};

// ─── Main parse ─────────────────────────────────────────────────────────────

function parseMastersJson(buffer) {
  const text = decodeBuffer(buffer);
  const rawObjects = collectObjects(text);

  const groupObjs = rawObjects.filter((o) => o.type === "Group");
  const ledgerObjs = rawObjects.filter((o) => o.type === "Ledger");

  if (groupObjs.length === 0 && ledgerObjs.length === 0) {
    throw new Error(
      "No Tally groups or ledgers found. Make sure you exported via " +
        "Gateway of Tally → Display More Reports → List of Accounts → " +
        "Export → JSON → All Masters.",
    );
  }

  // ── Pass A: groups ───────────────────────────────────────────────
  const groupMap = new Map();
  const groupParentMap = new Map();
  for (const { parsed: d } of groupObjs) {
    const name = d?.metadata?.name;
    if (!name) continue;
    const key = String(name).toLowerCase();
    if (groupMap.has(key)) continue;
    const parent = unwrapTaggedString(d.parent || "");
    groupMap.set(key, { name, parent: parent || null });
    if (parent) groupParentMap.set(key, parent);
  }
  for (const primary of Object.keys(PRIMARY_NATURE)) {
    if (!groupMap.has(primary)) {
      const canon = primary
        .split(" ")
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(" ")
        .replace("(asset)", "(ASSET)");
      groupMap.set(primary, { name: canon, parent: null });
    }
  }
  const groups = [...groupMap.values()].map((g) => ({
    name: g.name,
    parent: g.parent,
    nature: resolveNature(g.name, groupParentMap),
    isPrimary: !g.parent,
  }));

  // ── Pass B: ledgers ──────────────────────────────────────────────
  const ledgerMap = new Map();
  for (const { parsed: d } of ledgerObjs) {
    const name = d?.metadata?.name;
    if (!name) continue;
    const key = String(name).toLowerCase();
    if (ledgerMap.has(key)) continue;

    const rawParent = unwrapTaggedString(d.parent || "");
    const parentGroup =
      rawParent || SYSTEM_LEDGER_GROUPS[key] || "Suspense A/c";

    let gstin = "";
    let gstRegistrationType = "";
    let placeOfSupply = "";
    const gstReg =
      Array.isArray(d.ledgstregdetails) && d.ledgstregdetails.length
        ? d.ledgstregdetails[0]
        : null;
    if (gstReg) {
      gstin = unwrapTaggedString(gstReg.gstin || "");
      gstRegistrationType = unwrapTaggedString(
        gstReg.gstregistrationtype || "",
      );
      placeOfSupply = unwrapTaggedString(gstReg.placeofsupply || "");
    }
    if (!gstin && d.gstin) gstin = unwrapTaggedString(d.gstin);
    if (!gstin && d.partygstin) gstin = unwrapTaggedString(d.partygstin);
    gstin = gstin ? gstin.toUpperCase() : "";

    let address = "";
    let pincode = "";
    let state = "";
    let country = "";
    const mail =
      Array.isArray(d.ledmailingdetails) && d.ledmailingdetails.length
        ? d.ledmailingdetails[0]
        : null;
    if (mail) {
      address = unwrapTaggedString(mail.address || "");
      pincode = unwrapTaggedString(mail.pincode || "");
      state = unwrapTaggedString(mail.state || "");
      country = unwrapTaggedString(mail.country || "");
    }
    if (!state)
      state = unwrapTaggedString(
        d.statename || d.priorstatename || d.lstatename || "",
      );
    if (!country)
      country = unwrapTaggedString(d.countryname || d.countryofresidence || "");

    // ── Opening balance: DO NOT trust Masters here ──────────────────
    // When the Masters export is taken with "Export closing balance as
    // opening balance = Yes" (required to get other detail), Tally
    // writes each ledger's CLOSING balance into the `openingbalance`
    // field. Using that as the opening AND then posting the Day Book
    // movements double-counts every such ledger (verified: 117 ledgers
    // here, e.g. Owner's Capital would become 47,00,000 + 46,95,000 =
    // 93,95,000). The ONLY authoritative source of true opening
    // balances is the ledger-wise Trial Balance (dspopamt), applied
    // separately by tallyTrialBalanceOpenings + the opening-balance
    // endpoint. So Masters always seeds opening = 0; the Trial Balance
    // step sets the real openings (here: only Capital ₹5,000 & Indian
    // Bank −₹5,000). This makes closing = 0 + Day Book movement, then
    // the TB step adds the true opening — matching Tally exactly.
    const ob = 0;

    const openingBalance = Math.abs(ob);
    const openingBalanceType = ob < 0 ? "Cr" : "Dr";

    const gstApplicableRaw = String(d.isgstapplicable).toLowerCase();
    const isGstApplicable =
      gstApplicableRaw.includes("true") ||
      gstApplicableRaw.includes("yes") ||
      !!gstin;

    // Tally's "Profit & Loss A/c" is a RESERVED, system-computed ledger
    // — it never appears in the Trial Balance and must NOT be presented
    // as a normal equity ledger, or the Balance Sheet shows TWO P&L
    // lines (the real one in Equity + the synthetic current-period one
    // in Assets). Flag it so downstream excludes it from buckets.
    const reservedName = String(d?.metadata?.reservedname || "").toLowerCase();
    const isReserved =
      reservedName === "profit & loss a/c" || key === "profit & loss a/c";

    ledgerMap.set(key, {
      name,
      parent: parentGroup,
      openingBalance,
      openingBalanceType,
      isReserved,
      gstin: gstin || null,
      gstRegistrationType: gstRegistrationType || null,
      placeOfSupply: placeOfSupply || null,
      address: address || null,
      pincode: pincode || null,
      state: state || null,
      country: country || "India",
      isGstApplicable,
    });
  }

  const ledgers = [...ledgerMap.values()];
  for (const l of ledgers) {
    l.nature = resolveNature(l.parent, groupParentMap);
    // The import-commit code keys group resolution off `groupName`
    // (with an override fallback). The parser historically only set
    // `parent`, so `groupName` was undefined for EVERY ledger and the
    // commit fell back to defaults — which is exactly why imported
    // ledgers landed under the wrong groups / the Balance Sheet was
    // mis-grouped. Expose `groupName` as the canonical Tally parent.
    l.groupName = l.parent;
  }

  const gstinCount = ledgers.filter((l) => l.gstin).length;
  const parentDist = {};
  for (const l of ledgers) {
    parentDist[l.parent] = (parentDist[l.parent] || 0) + 1;
  }

  return {
    groups,
    ledgers,
    stats: {
      groupCount: groups.length,
      ledgerCount: ledgers.length,
      ledgersWithGstin: gstinCount,
      parentDistribution: parentDist,
      objectsScanned: rawObjects.length,
      // Surfaced so the UI can clearly tell the user a masters file has no
      // transactions (the #1 confusion point).
      voucherCount: 0,
      isMastersOnly: true,
    },
  };
}

// ─── GSTIN → state inference (kept for back-compat re-exports) ───────────────

const GST_STATE_CODES = {
  "01": "Jammu & Kashmir",
  "02": "Himachal Pradesh",
  "03": "Punjab",
  "04": "Chandigarh",
  "05": "Uttarakhand",
  "06": "Haryana",
  "07": "Delhi",
  "08": "Rajasthan",
  "09": "Uttar Pradesh",
  10: "Bihar",
  11: "Sikkim",
  12: "Arunachal Pradesh",
  13: "Nagaland",
  14: "Manipur",
  15: "Mizoram",
  16: "Tripura",
  17: "Meghalaya",
  18: "Assam",
  19: "West Bengal",
  20: "Jharkhand",
  21: "Odisha",
  22: "Chhattisgarh",
  23: "Madhya Pradesh",
  24: "Gujarat",
  25: "Daman & Diu",
  26: "Dadra & Nagar Haveli and Daman & Diu",
  27: "Maharashtra",
  28: "Andhra Pradesh (Old)",
  29: "Karnataka",
  30: "Goa",
  31: "Lakshadweep",
  32: "Kerala",
  33: "Tamil Nadu",
  34: "Puducherry",
  35: "Andaman & Nicobar Islands",
  36: "Telangana",
  37: "Andhra Pradesh",
  38: "Ladakh",
  97: "Other Territory",
  99: "Centre Jurisdiction",
};

function stateFromGstin(gstin) {
  if (!gstin || gstin.length < 2) return null;
  const code = String(gstin).slice(0, 2);
  return GST_STATE_CODES[code] || null;
}

function stateCodeFromGstin(gstin) {
  if (!gstin || gstin.length < 2) return null;
  const code = String(gstin).slice(0, 2);
  return GST_STATE_CODES[code] ? code : null;
}

module.exports = {
  parseMastersJson,
  stateFromGstin,
  stateCodeFromGstin,
  GST_STATE_CODES,
  decodeBuffer, // tests
  collectObjects, // tests
  extractObjectsByType: collectObjects, // back-compat alias
};

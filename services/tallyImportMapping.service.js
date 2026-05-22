// services/tallyImportMapping.service.js
//
// IMPORT MAPPING SERVICE
// ─────────────────────────────────────────────────────────────────────────────
// Powers the "review & map" step of the Tally import wizard.
//
// 1. extractMappables(buffer)
//      Pulls every Sundry Creditor / Sundry Debtor ledger and every Stock
//      Item out of a Tally Master export, WITH the rich detail the file
//      carries (GSTIN, state, address, contact, parent group, base unit).
//
// 2. similarity(a, b)
//      Conservative fuzzy score (0..1) combining token-overlap (Jaccard)
//      and a length-normalised edit distance, after normalising away
//      company suffixes / punctuation / bracket codes. Used to AUTO-SUGGEST
//      a match (e.g. Tally "deeksha" ↔ existing "Diksha Textiles") that the
//      accountant then confirms — it never auto-merges on its own.
//
// 3. suggestForParties(tallyRows, existingRows)
//    suggestForStock(tallyItems, existingItems)
//      For each Tally row, returns the best existing candidate (by GSTIN
//      first where present, else name similarity) plus the top few
//      alternatives, so the UI can show a pre-selected dropdown.
//
// The heavy JSON walk reuses the same streaming object-split approach as
// tallyMastersImporter so it stays memory-safe on the 13–46 MB files.

"use strict";

// ─── Decode + object split (UTF-16LE BOM aware, streaming) ──────────────────
function decodeBuffer(buffer) {
  if (buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.toString("utf16le", 2);
  }
  if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.toString("utf8", 3);
  }
  return buffer.toString("utf8");
}

function unwrap(v) {
  if (Array.isArray(v)) {
    for (const el of v) {
      if (typeof el === "string") {
        const s = el.replace(/^\u0004\s*/, "").trim();
        if (s) return s;
      }
    }
    return "";
  }
  if (typeof v === "string") return v.replace(/^\u0004\s*/, "").trim();
  if (v == null || typeof v === "object") return "";
  return String(v);
}

// Join a Tally address block (array of string fragments, possibly with a
// leading metadata descriptor object) into one line.
function unwrapLines(v) {
  if (Array.isArray(v)) {
    return v
      .filter((el) => typeof el === "string")
      .map((el) => el.replace(/^\u0004\s*/, "").trim())
      .filter(Boolean)
      .join(", ");
  }
  return unwrap(v);
}

// Pull the tallymessage array text and split top-level objects without
// JSON.parsing the whole 14 MB string at once.
function splitMessages(text) {
  const key = '"tallymessage"';
  let k = text.indexOf(key);
  if (k < 0) return [];
  let i = text.indexOf("[", k);
  if (i < 0) return [];
  const out = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (; i < text.length; i++) {
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
    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        out.push(text.slice(start, i + 1));
        start = -1;
      }
    } else if (ch === "]" && depth === 0) {
      break;
    }
  }
  return out;
}

// ─── Extract the things the accountant needs to map ─────────────────────────
function extractMappables(buffer) {
  const text = decodeBuffer(buffer);
  const chunks = splitMessages(text);

  const creditors = [];
  const debtors = [];
  const stockItems = [];

  for (const raw of chunks) {
    let o;
    try {
      o = JSON.parse(raw);
    } catch {
      continue;
    }
    const meta = o && o.metadata;
    if (!meta || !meta.type) continue;
    const type = meta.type;
    const name = (meta.name || "").trim();
    if (!name) continue;

    if (type === "Ledger") {
      const parent = unwrap(o.parent);
      const isCred = /sundry creditor/i.test(parent);
      const isDeb = /sundry debtor/i.test(parent);
      if (!isCred && !isDeb) continue;

      let gstin = "";
      const reg = Array.isArray(o.ledgstregdetails)
        ? o.ledgstregdetails.find((x) => x && typeof x === "object")
        : o.ledgstregdetails;
      if (reg && typeof reg === "object")
        gstin = unwrap(reg.gstin || reg.gstregnum || "");
      if (!gstin && o.gstin) gstin = unwrap(o.gstin);

      let address = "";
      let state = "";
      let pincode = "";
      const mail = Array.isArray(o.ledmailingdetails)
        ? o.ledmailingdetails.find((x) => x && typeof x === "object")
        : o.ledmailingdetails;
      if (mail && typeof mail === "object") {
        address = unwrapLines(mail.address);
        state = unwrap(mail.state);
        pincode = unwrap(mail.pincode);
      }
      if (!state) state = unwrap(o.priorstatename || o.statename || "");

      let email = "";
      let phone = "";
      const cd = Array.isArray(o.contactdetails)
        ? o.contactdetails.find((x) => x && typeof x === "object")
        : o.contactdetails;
      if (cd && typeof cd === "object") {
        email = unwrap(cd.email || cd.emailid || "");
        phone = unwrap(cd.phone || cd.mobile || cd.ledgerphone || "");
      }

      const row = {
        tallyName: name,
        parent,
        gstin: (gstin || "").toUpperCase().replace(/\s+/g, ""),
        state,
        address,
        pincode,
        email,
        phone,
        guid: o.guid || null,
      };
      if (isCred) creditors.push(row);
      else debtors.push(row);
    } else if (type === "Stock Item") {
      stockItems.push({
        tallyName: name,
        parent: unwrap(o.parent),
        baseUnit: unwrap(o.baseunits),
        gstApplicable: /applicable/i.test(unwrap(o.gstapplicable || "")),
        guid: o.guid || null,
      });
    }
  }

  return {
    creditors, // → map to Vendors
    debtors, // → map to Customers
    stockItems, // → map to Inventory stock items (or keep as text)
    counts: {
      creditors: creditors.length,
      debtors: debtors.length,
      stockItems: stockItems.length,
    },
  };
}

// ─── Fuzzy matching ─────────────────────────────────────────────────────────
function norm(s) {
  return (
    String(s || "")
      .toLowerCase()
      .replace(/\(.*?\)/g, " ")
      // "Advance Mayfair Kalimpong A/c" and "Mayfair Kalimpong" are the SAME
      // party kept as two ledgers (an advance/loan account + the trade
      // account). Strip the leading "advance"/"adv" and trailing "a/c",
      // "account", "ac" so the base party name lines up and the advance
      // ledger SUGGESTS the real customer/vendor for the accountant.
      .replace(/^\s*(advance|adv|advances)\b/, " ")
      .replace(/\b(a\s*\/?\s*c|account|ac)\s*$/, " ")
      .replace(
        /\b(pvt|private|ltd|limited|llp|opc|inc|co|company|enterprises?|traders?|textiles?|industries|and|the|&)\b/g,
        " ",
      )
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

function lev(a, b) {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  let cur = new Array(n + 1);
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}

function similarity(a, b) {
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const ta = new Set(na.split(" "));
  const tb = new Set(nb.split(" "));
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const jac = inter / new Set([...ta, ...tb]).size;
  const ed = 1 - lev(na, nb) / Math.max(na.length, nb.length);
  // Weight token overlap a bit higher — it handles word re-ordering
  // ("Diksha Textiles" vs "Textiles Diksha") better than raw edit dist.
  return Math.max(jac * 0.6 + Math.max(jac, ed) * 0.4, ed);
}

// existingRows: [{ id, name, gstin? }]
function suggestForParties(tallyRows, existingRows, opts = {}) {
  // 0.62 was catching weak coincidences (e.g. two firms that merely share
  // the word "Enterprisers"). 0.78 keeps strong matches like
  // "deeksha"/"Diksha Textiles" (~0.71 was borderline — but GSTIN match,
  // when present, still wins at score 1 regardless of this threshold) and
  // pushes genuinely-unrelated names to a safe "Create new" default that
  // the accountant can still override from the full dropdown.
  const minScore = opts.minScore ?? 0.72;
  const byGstin = new Map();
  for (const e of existingRows) {
    const g = (e.gstin || "").toUpperCase().replace(/\s+/g, "");
    if (g) byGstin.set(g, e);
  }
  return tallyRows.map((t) => {
    let best = null;
    let bestScore = 0;
    let reason = null;

    if (t.gstin && byGstin.has(t.gstin)) {
      best = byGstin.get(t.gstin);
      bestScore = 1;
      reason = "GSTIN match";
    } else {
      const scored = existingRows
        .map((e) => ({ e, s: similarity(t.tallyName, e.name) }))
        .sort((x, y) => y.s - x.s);
      if (scored.length && scored[0].s >= minScore) {
        best = scored[0].e;
        bestScore = scored[0].s;
        reason = "Name match";
      }
      var alternatives = scored
        .slice(0, 5)
        .filter((x) => x.s > 0.3)
        .map((x) => ({ id: x.e.id, name: x.e.name, score: round2(x.s) }));
    }

    return {
      tally: t,
      suggestedId: best ? best.id : null,
      suggestedName: best ? best.name : null,
      score: round2(bestScore),
      reason,
      // action the UI defaults to: link if confident, else create-new
      defaultAction: best ? "link" : "create",
      alternatives: typeof alternatives !== "undefined" ? alternatives : [],
    };
  });
}

function suggestForStock(tallyItems, existingItems, opts = {}) {
  const minScore = opts.minScore ?? 0.7;
  return tallyItems.map((t) => {
    const scored = existingItems
      .map((e) => ({ e, s: similarity(t.tallyName, e.name) }))
      .sort((x, y) => y.s - x.s);
    const top = scored[0];
    const hit = top && top.s >= minScore ? top : null;
    return {
      tally: t,
      suggestedId: hit ? hit.e.id : null,
      suggestedName: hit ? hit.e.name : null,
      score: round2(hit ? hit.s : 0),
      // If no inventory match, default is to keep the Tally name as plain
      // text on the voucher (do NOT force-create an inventory item).
      defaultAction: hit ? "link" : "text",
      alternatives: scored
        .slice(0, 5)
        .filter((x) => x.s > 0.35)
        .map((x) => ({ id: x.e.id, name: x.e.name, score: round2(x.s) })),
    };
  });
}

function round2(n) {
  return Math.round((n || 0) * 100) / 100;
}

module.exports = {
  extractMappables,
  similarity,
  suggestForParties,
  suggestForStock,
  _norm: norm,
};

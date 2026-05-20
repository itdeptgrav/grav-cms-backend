// services/tallyBSheetSummary.service.js
//
// TALLY BALANCE-SHEET *SUMMARY* PARSER  (reconciliation / verification)
// ─────────────────────────────────────────────────────────────────────────────
// There are THREE different "Balance Sheet"-ish JSON exports from Tally and
// they are constantly confused. This module handles the SMALL one and is used
// purely to VERIFY an import is accurate — never to create data.
//
//   1. List of Accounts → All Masters     → groups + ledgers + opening bals
//      (parsed by tallyMastersImporter.service.js)
//   2. Group Summary drill-down           → ledgers + every voucher
//      (parsed by tallyBSheetImporter.service.js — this is the one with
//       1700+ vouchers, ~3 MB)
//   3. Balance Sheet (top level)          → JUST the 5-6 primary group
//      totals, no ledgers, no vouchers (~1 KB). THIS module.
//
// Shape of #3 (verified against a real GRAV export):
//
//   {
//     "bsbody": { "bsinfo": {
//       "bssources": { "bsdetail": [
//         { "bsname": { "dspaccname": { "dspdispname": "Capital Account" } },
//           "bsamt": [ { "bsmainamt": 4681000.00 } ] }, ...
//       ] },
//       "bsapp": { "bsdetail": [
//         { "bsname": { "dspaccname": { "dspdispname": "Fixed Assets" } },
//           "bsamt": [ {} ] },                          // empty = 0
//         { "bsname": { "dspaccname": { "dspdispname": "Working Capital" } },
//           "bsamt": [ { "bsmainamt": 6714220.03 } ] }
//       ] }
//     } }
//   }
//
// Tally's Balance Sheet convention here:
//   • bssources = LIABILITIES side (Capital, Loans, P&L, …) — "Sources of Funds"
//   • bsapp     = ASSETS side (Fixed Assets, Working Capital, …) — "Application"
//   • Working Capital is a NET figure = Current Assets − Current Liabilities,
//     so it is NOT a primary group you can match 1:1 against the CoA. We
//     surface it but flag it as a derived/net line.
//   • A "P&L A/c" negative number on the sources side is the accumulated
//     profit (Cr, normal) or loss; sign follows Tally (Cr = negative here).
//
// API:
//   parseBSheetSummary(buffer) → {
//     ok: true,
//     sources: [ { name, amount } ],   // liabilities-side primary totals
//     application: [ { name, amount } ],// assets-side primary totals
//     sourcesTotal, applicationTotal
//   }
//   isBSheetSummary(buffer) → boolean   // cheap shape sniff for routing

function decodeBuffer(buffer) {
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);
  const attempts = [];
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe)
    attempts.push(buffer.slice(2).toString("utf16le"));
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    const sw = Buffer.alloc(buffer.length - 2);
    for (let i = 2; i < buffer.length; i += 2) {
      if (i + 1 < buffer.length) {
        sw[i - 2] = buffer[i + 1];
        sw[i - 1] = buffer[i];
      }
    }
    attempts.push(sw.toString("utf16le"));
  }
  if (buffer.length >= 4 && buffer[1] === 0x00 && buffer[3] === 0x00)
    attempts.push(buffer.toString("utf16le"));
  if (
    buffer.length >= 3 &&
    buffer[0] === 0xef &&
    buffer[1] === 0xbb &&
    buffer[2] === 0xbf
  )
    attempts.push(buffer.slice(3).toString("utf8"));
  attempts.push(buffer.toString("utf8"));
  for (const t of attempts) if (t && t.includes('"bsbody"')) return t;
  return attempts.find((t) => t && t.length > 0) || buffer.toString("utf8");
}

function _amt(bsamt) {
  // bsamt is an array; the amount lives in bsmainamt. Empty {} = 0.
  if (!Array.isArray(bsamt)) {
    if (bsamt && typeof bsamt === "object")
      return Number(bsamt.bsmainamt || 0) || 0;
    return 0;
  }
  let v = 0;
  for (const a of bsamt) {
    if (a && a.bsmainamt != null) {
      const n = Number(a.bsmainamt);
      if (Number.isFinite(n)) v = n; // last non-empty wins (Tally repeats)
    }
  }
  return v;
}

function _name(bsname) {
  return (
    (bsname &&
      bsname.dspaccname &&
      typeof bsname.dspaccname.dspdispname === "string" &&
      bsname.dspaccname.dspdispname.trim()) ||
    null
  );
}

function _rows(detail) {
  if (!detail) return [];
  let arr = detail.bsdetail;
  if (!arr) return [];
  if (!Array.isArray(arr)) arr = [arr];
  const out = [];
  for (const d of arr) {
    const nm = _name(d.bsname);
    if (!nm) continue;
    out.push({ name: nm, amount: _amt(d.bsamt) });
  }
  return out;
}

function isBSheetSummary(buffer) {
  try {
    const t = decodeBuffer(buffer);
    if (!t.includes('"bsbody"')) return false;
    const d = JSON.parse(t);
    return !!(d && d.bsbody && d.bsbody.bsinfo);
  } catch {
    return false;
  }
}

function parseBSheetSummary(buffer) {
  const text = decodeBuffer(buffer);
  let d;
  try {
    d = JSON.parse(text);
  } catch (e) {
    throw new Error(
      "This doesn't look like a Tally Balance Sheet summary JSON.",
    );
  }
  const info = d && d.bsbody && d.bsbody.bsinfo;
  if (!info)
    throw new Error(
      "Missing 'bsbody.bsinfo' — not a Tally Balance Sheet summary export.",
    );

  const sources = _rows(info.bssources); // liabilities side
  const application = _rows(info.bsapp); // assets side

  if (sources.length === 0 && application.length === 0) {
    throw new Error("Balance Sheet summary had no rows.");
  }

  const sourcesTotal = sources.reduce((s, r) => s + r.amount, 0);
  const applicationTotal = application.reduce((s, r) => s + r.amount, 0);

  return {
    ok: true,
    sources,
    application,
    sourcesTotal,
    applicationTotal,
  };
}

module.exports = {
  parseBSheetSummary,
  isBSheetSummary,
  decodeBuffer, // tests
};

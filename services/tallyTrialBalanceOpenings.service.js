// services/tallyTrialBalanceOpenings.service.js
// ---------------------------------------------------------------------------
// Parses Tally "Trial Balance" or "Group Summary" JSON → leaf ledger balances.
//
// TALLY SIGN CONVENTIONS (verified against real data, sums to 0.00):
//   dspclamt  >0 = Cr,   <0 = Dr     |  dspopamt  same convention
//   dspdramt  always negative         |  dspcramt  always positive
//   dspopdramt negative = Dr opening  |  dspopcramt positive = Cr opening
//   dspcldramt negative = Dr closing  |  dspclcramt positive = Cr closing
//
// Internal convention: Dr +, Cr −
//   openingSigned = -dspopamt   |  closingSigned = -dspclamt
// ---------------------------------------------------------------------------

function decodeBuffer(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.toString("utf16le", 2);
  if (buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.alloc(buf.length - 2);
    for (let i = 2; i + 1 < buf.length; i += 2) {
      swapped[i - 2] = buf[i + 1];
      swapped[i - 1] = buf[i];
    }
    return swapped.toString("utf16le");
  }
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf)
    return buf.toString("utf8", 3);
  return buf.toString("utf8");
}

function sanitizeTallyJson(text) {
  return text.replace(/,\s*"[A-Za-z0-9_]+"\s*:\s*(Cr|Dr)\b/g, "");
}

function firstNumeric(obj) {
  if (!obj || typeof obj !== "object") return null;
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() !== "") {
      const n = parseFloat(v.replace(/[^0-9.\-]/g, ""));
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

function nodeName(node) {
  const dn = node && node.dspaccname && node.dspaccname.dspdispname;
  return dn == null ? "" : String(dn).trim();
}

function childLines(node) {
  const ge = node && node.grpexplosion;
  if (!ge) return [];
  const lines = ge.dspaccline;
  if (!lines) return [];
  return Array.isArray(lines) ? lines : [lines];
}

function parseTrialBalanceOpenings(buffer) {
  const warnings = [];
  let text = decodeBuffer(buffer);
  let data;
  try {
    data = JSON.parse(text);
  } catch (e1) {
    try {
      data = JSON.parse(sanitizeTallyJson(text));
      warnings.push(
        "Tally JSON had malformed bill-allocation entries; auto-sanitised.",
      );
    } catch (e2) {
      throw new Error(
        `Could not parse Trial Balance JSON: ${e2.message}. ` +
          `Make sure this is a Trial Balance export.`,
      );
    }
  }

  const body = data && data.dspaccbody;
  const top = body && body.dspaccline;
  if (!top) {
    throw new Error(
      "Missing dspaccbody.dspaccline — not a Trial Balance JSON.",
    );
  }
  const topLines = Array.isArray(top) ? top : [top];

  const probe = topLines.find((l) => l && l.dspaccinfo && l.dspaccinfo[0]);
  const probeInfo = probe ? probe.dspaccinfo[0] : {};
  const has = (k) =>
    probeInfo && Object.prototype.hasOwnProperty.call(probeInfo, k);
  const hasSingleOpening = has("dspopamt") || has("dspnettamt");
  const hasExplicitOpening = has("dspopdramt") || has("dspopcramt");
  const hasSingleClosing = has("dspclamt");
  const hasExplicitClosing = has("dspcldramt") || has("dspclcramt");
  const hasPeriodMovements = has("dspdramt") || has("dspcramt");
  const hasAnyUsable =
    hasSingleOpening ||
    hasExplicitOpening ||
    hasSingleClosing ||
    hasExplicitClosing ||
    hasPeriodMovements;

  if (!hasAnyUsable) {
    return {
      ledgers: [],
      openingCount: 0,
      ledgerCount: 0,
      totals: { openDr: 0, openCr: 0, closeDr: 0, closeCr: 0 },
      warnings: [
        "No recognisable columns in this Trial Balance / Group Summary.",
      ],
      exportKind: "unusable",
      isDetailed: false,
      hasOpeningColumn: false,
      usableForOpenings: false,
    };
  }

  const ledgers = [];
  let ledgerCount = 0;

  const visit = (node, parentName) => {
    const name = nodeName(node);
    const kids = childLines(node);
    const info =
      node.dspaccinfo && node.dspaccinfo[0] ? node.dspaccinfo[0] : {};

    const opDrRaw = firstNumeric(info.dspopdramt);
    const opCrRaw = firstNumeric(info.dspopcramt);
    const opening = firstNumeric(info.dspopamt);
    const net = firstNumeric(info.dspnettamt);
    const clSingle = firstNumeric(info.dspclamt);
    const clDr = firstNumeric(info.dspcldramt);
    const clCr = firstNumeric(info.dspclcramt);
    // Period movement fields — needed to detect zero-closing ledgers
    // that still had transactions (42 such ledgers exist in real data).
    const drAmt = firstNumeric(info.dspdramt);
    const crAmt = firstNumeric(info.dspcramt);

    // ── CLOSING ─────────────────────────────────────────────────────
    let closingRaw = clSingle;
    if (closingRaw == null) {
      const cDr = clDr || 0;
      const cCr = clCr || 0;
      if (cDr !== 0 || cCr !== 0) {
        closingRaw = cCr + cDr;
      }
    }
    // If closing field is absent but Dr and Cr movements are equal and
    // non-zero, the ledger has a ZERO closing (verified: 42 such
    // ledgers in real data). Without this, these ledgers are silently
    // dropped and their balanceFromTrialBalance flag never gets set,
    // causing the BS to recompute from Day Book → ₹5,200 asymmetry.
    if (closingRaw == null && drAmt != null && crAmt != null) {
      closingRaw = 0;
    }

    // ── OPENING (Dr +, Cr −) ────────────────────────────────────────
    let openingSigned = null;
    if (opCrRaw != null && opCrRaw !== 0) {
      openingSigned = -Math.abs(opCrRaw);
    } else if (opDrRaw != null && opDrRaw !== 0) {
      openingSigned = Math.abs(opDrRaw);
    } else if (opening != null && opening !== 0) {
      openingSigned = -opening;
    } else {
      openingSigned = 0;
    }

    // Recurse into group/subgroup children
    if (kids.length > 0) {
      for (const k of kids) visit(k, name || parentName);
      return;
    }

    // Leaf detection: include if ANY data field is present.
    // CRITICAL: also check dspdramt/dspcramt — without these, ledgers
    // with zero closing but non-zero period movements get dropped.
    if (
      opening == null &&
      net == null &&
      closingRaw == null &&
      opDrRaw == null &&
      opCrRaw == null &&
      clDr == null &&
      clCr == null &&
      drAmt == null &&
      crAmt == null
    )
      return;

    ledgerCount += 1;
    const opVal = openingSigned == null ? 0 : openingSigned;
    const clVal = closingRaw == null ? 0 : closingRaw;
    const clSigned = -clVal;
    ledgers.push({
      name,
      parentName: parentName || "",
      opening: Math.abs(opVal),
      openingType: opVal < 0 ? "Cr" : "Dr",
      openingSigned: opVal,
      closing: clVal,
      closingSigned: clSigned,
      closingBalance: Math.abs(clSigned),
      closingType: clSigned < 0 ? "Cr" : "Dr",
      net: net == null ? 0 : net,
    });
  };

  for (const ln of topLines) visit(ln, "");

  const totals = { openDr: 0, openCr: 0, closeDr: 0, closeCr: 0 };
  let openingCount = 0;
  for (const l of ledgers) {
    if (l.openingSigned !== 0) openingCount += 1;
    if (l.openingSigned < 0) totals.openCr += Math.abs(l.openingSigned);
    else totals.openDr += l.openingSigned;
    if (l.closingSigned < 0) totals.closeCr += Math.abs(l.closingSigned);
    else totals.closeDr += l.closingSigned;
  }

  const isDetailed = ledgerCount >= 10;
  const hasOpeningColumn = openingCount > 0 || isDetailed;
  let exportKind = "unknown";
  if (!isDetailed && ledgerCount === 0) exportKind = "short_group_summary";
  else if (isDetailed && openingCount > 0)
    exportKind = "detailed_with_openings";
  else if (isDetailed && openingCount === 0)
    exportKind = "detailed_no_openings";

  if (exportKind === "short_group_summary") {
    warnings.push(
      "SHORT group-level Trial Balance. Re-export: F5 Ledger-wise → F12 Show Opening Balance = Yes.",
    );
  } else if (exportKind === "detailed_no_openings") {
    warnings.push(
      "All openings are zero. Re-export with F12 'Show Opening Balance' = Yes if needed.",
    );
  }

  return {
    ledgers,
    openingCount,
    ledgerCount,
    totals,
    warnings,
    exportKind,
    isDetailed,
    hasOpeningColumn,
    usableForOpenings: openingCount > 0,
  };
}

module.exports = { parseTrialBalanceOpenings, decodeBuffer, sanitizeTallyJson };

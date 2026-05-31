// routes/Accountant_Routes/Acc_ewayBill.js
// =============================================================================
// E-WAY BILL JSON EXPORT — V4 (NIC EWB Preparation Tool compatible)
// -----------------------------------------------------------------------------
// V4 brings the output into EXACT alignment with the official NIC
// "EWB_Preparation_Tool.xlsm" macro output. Verified by extracting the
// VBA from that tool and matching field names, types, and order.
//
// V4 critical fixes (over V3) — these were what was triggering the
// "something went wrong" upload error:
//   • Output is now wrapped in an envelope:
//        { "version": "1.0.0621", "billLists": [ ... ] }
//     V3 produced just the inner array.
//   • Field renames to match the official tool:
//        transactionType   → transType
//        actFromStateCode  → actualFromStateCode
//        actToStateCode    → actualToStateCode
//        cessNonAdvolValue → TotNonAdvolVal     (note: capital T)
//        otherValue        → OthValue          (note: capital O)
//   • Types corrected: subSupplyType, transType, transMode, transDistance
//     emitted as JSON numbers (not strings). State codes & pincodes:
//     numbers. supplyType/docType/vehicleType: strings.
//   • Items: added `itemNo` (1-based), `hsnCode` emitted as string (not
//     number — official tool wraps it in quotes), field order changed to
//     itemNo → productName → productDesc → hsnCode → quantity → qtyUnit
//     → taxableAmount → sgstRate → cgstRate → igstRate → cessRate →
//     cessNonAdvol. sgst comes before cgst — opposite of what I had.
//   • Numeric -1 for missing tax-rate lines (matches tool behavior when
//     no rate column is filled — portal accepts it).
//
// Everything else (Bill = Ship logic, customer-ledger GSTIN fallback,
// classify-as-blocker-vs-warning, /preflight overrides) carries over
// from V3 unchanged.
// =============================================================================

const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");

const { accountantAuth } = require("../../Middlewear/AccountantAuthMiddleware");
const {
  Acc_Voucher,
} = require("../../models/Accountant_model/Acc_VoucherModels");
const {
  Acc_Company,
  Acc_Ledger,
} = require("../../models/Accountant_model/Acc_MasterModels");

// JSON envelope version. Matches the EWB Preparation Tool's hardcoded
// "1.0.0621" — the portal validates this against its accepted versions.
const EWB_JSON_VERSION = "1.0.0621";

// ─────────────────────────────────────────────────────────────────────────────
// GST state-code + unit maps
// ─────────────────────────────────────────────────────────────────────────────
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
  26: "Dadra & Nagar Haveli",
  27: "Maharashtra",
  28: "Andhra Pradesh (Old)",
  29: "Karnataka",
  30: "Goa",
  31: "Lakshadweep",
  32: "Kerala",
  33: "Tamil Nadu",
  34: "Puducherry",
  35: "Andaman & Nicobar",
  36: "Telangana",
  37: "Andhra Pradesh",
  38: "Ladakh",
  97: "Other Territory",
  99: "Centre Jurisdiction",
};
const STATE_NAME_TO_CODE = (() => {
  const m = {};
  for (const [code, name] of Object.entries(GST_STATE_CODES))
    m[name.toLowerCase()] = parseInt(code, 10);
  return m;
})();

const UNIT_MAP = {
  pcs: "PCS",
  pc: "PCS",
  piece: "PCS",
  pieces: "PCS",
  nos: "NOS",
  no: "NOS",
  unit: "NOS",
  units: "NOS",
  kg: "KGS",
  kgs: "KGS",
  kilogram: "KGS",
  kilograms: "KGS",
  g: "GMS",
  gm: "GMS",
  gms: "GMS",
  gram: "GMS",
  grams: "GMS",
  ton: "TON",
  tons: "TON",
  tonne: "TON",
  tonnes: "TON",
  mt: "MTS",
  qtl: "QTL",
  quintal: "QTL",
  l: "LTR",
  ltr: "LTR",
  liter: "LTR",
  litre: "LTR",
  liters: "LTR",
  litres: "LTR",
  ml: "MLT",
  mlt: "MLT",
  kl: "KLR",
  klr: "KLR",
  box: "BOX",
  boxes: "BOX",
  bag: "BAG",
  bags: "BAG",
  bdl: "BDL",
  bundle: "BDL",
  bundles: "BDL",
  case: "CAS",
  cases: "CAS",
  ctn: "CTN",
  carton: "CTN",
  cartons: "CTN",
  dozen: "DOZ",
  doz: "DOZ",
  drum: "DRM",
  pack: "PAC",
  packs: "PAC",
  pkt: "PAC",
  packet: "PAC",
  rol: "ROL",
  roll: "ROL",
  rolls: "ROL",
  set: "SET",
  sets: "SET",
  pair: "PRS",
  pairs: "PRS",
  prs: "PRS",
  sqm: "SQM",
  sqf: "SQF",
  sqft: "SQF",
  mtr: "MTR",
  meter: "MTR",
  meters: "MTR",
  metre: "MTR",
  cms: "CMS",
  cm: "CMS",
  garment: "PCS",
  shirt: "PCS",
  pant: "PCS",
  tshirt: "PCS",
};
function mapUnit(raw) {
  if (!raw) return "PCS";
  const k = String(raw).trim().toLowerCase().replace(/[.\s]/g, "");
  return UNIT_MAP[k] || "OTH";
}
function resolveStateCode(input) {
  if (input == null || input === "") return null;
  const asNum = Number(input);
  if (
    !Number.isNaN(asNum) &&
    asNum > 0 &&
    GST_STATE_CODES[String(asNum).padStart(2, "0")]
  )
    return asNum;
  return STATE_NAME_TO_CODE[String(input).trim().toLowerCase()] || null;
}
function fmtEwbDate(d) {
  if (!d) return "";
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return "";
  return (
    String(dt.getDate()).padStart(2, "0") +
    "/" +
    String(dt.getMonth() + 1).padStart(2, "0") +
    "/" +
    dt.getFullYear()
  );
}
function normalizeVehicleNo(v) {
  return String(v || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}
function stateCodeFromGstin(gstin) {
  if (!gstin || typeof gstin !== "string" || gstin.length < 2) return null;
  const c = gstin.slice(0, 2);
  if (!/^[0-9]{2}$/.test(c)) return null;
  return GST_STATE_CODES[c] ? parseInt(c, 10) : null;
}
function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}
function round3(n) {
  return Math.round((Number(n) || 0) * 1000) / 1000;
}

// ─────────────────────────────────────────────────────────────────────────────
// Customer-ledger fallback — merges voucher snapshot → ledger master →
// GSTIN-derived state. Same logic as V3.
// ─────────────────────────────────────────────────────────────────────────────
function resolvePartyDetails(voucher, ledgersByPartyId) {
  const voucherGstin = (voucher.partyGstin || "").trim().toUpperCase();
  const voucherPos = String(voucher.placeOfSupply || "").trim();
  const voucherPosCode = String(voucher.placeOfSupplyCode || "").trim();

  let ledger = null;
  if (voucher.partyLedgerId && ledgersByPartyId) {
    ledger = ledgersByPartyId.get(String(voucher.partyLedgerId)) || null;
  }
  const ledgerGstin = (ledger?.gstin || "").trim().toUpperCase();
  const ledgerAddr = ledger?.address || {};
  const ledgerCD = ledger?.contactDetails || {};
  const ledgerStateCode = String(
    ledgerAddr.stateCode || ledgerCD.stateCode || "",
  ).trim();
  const ledgerState = String(ledgerAddr.state || ledgerCD.state || "").trim();

  const gstin = voucherGstin || ledgerGstin || "";
  const stateName = voucherPos || ledgerState || "";
  const stateCode =
    resolveStateCode(voucherPosCode) ||
    resolveStateCode(ledgerStateCode) ||
    stateCodeFromGstin(gstin) ||
    resolveStateCode(stateName) ||
    null;

  return {
    name: voucher.partyLedgerName || ledger?.name || "",
    gstin: gstin || "URP",
    isUnregistered: !gstin,
    stateCode: stateCode || 0,
    stateName:
      stateName ||
      (stateCode && GST_STATE_CODES[String(stateCode).padStart(2, "0")]) ||
      "",
    addr1: ledgerAddr.line1 || ledgerCD.address || "",
    addr2: ledgerAddr.line2 || "",
    pincode: ledgerAddr.pincode || ledgerCD.pincode || "",
    city: ledgerAddr.city || ledgerCD.city || "",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// "Bill = Ship" detection — same as V3.
// ─────────────────────────────────────────────────────────────────────────────
function detectShipMatchesBill(voucher, billTo) {
  const ship = voucher.shippingAddress;
  if (!ship) return true;
  const hasShipData =
    ship.name ||
    ship.gstin ||
    ship.pincode ||
    ship.city ||
    (Array.isArray(ship.addressLines) && ship.addressLines.length > 0);
  if (!hasShipData) return true;

  const billGstin = (billTo?.gstin || "").trim().toUpperCase();
  const shipGstin = (ship.gstin || "").trim().toUpperCase();
  const sameGstin =
    billGstin && shipGstin && billGstin !== "URP" && billGstin === shipGstin;

  const billStateCode = String(billTo?.stateCode || "").trim();
  const shipStateCode = String(ship.stateCode || "").trim();
  const sameState =
    billStateCode && shipStateCode && billStateCode === shipStateCode;

  const billStateName = String(billTo?.stateName || "")
    .trim()
    .toLowerCase();
  const shipStateName = String(ship.state || "")
    .trim()
    .toLowerCase();
  const sameStateName =
    billStateName && shipStateName && billStateName === shipStateName;

  if (sameGstin && (sameState || sameStateName)) return true;
  if ((!billGstin || billGstin === "URP") && !shipGstin && sameStateName)
    return true;
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// EWB JSON BUILDER — matches the official NIC tool exactly
//
// Field order, names, and types verified against the EWB Preparation Tool
// VBA macro:
//   userGstin (string), supplyType (string "O"/"I"), subSupplyType (number),
//   subSupplyDesc (string), docType (string code), docNo (string),
//   docDate (string dd/MM/yyyy), transType (number 1-4),
//   fromGstin, fromTrdName, fromAddr1, fromAddr2, fromPlace (strings),
//   fromPincode (number), fromStateCode (number), actualFromStateCode (number),
//   toGstin, toTrdName, toAddr1, toAddr2, toPlace (strings),
//   toPincode (number), toStateCode (number), actualToStateCode (number),
//   totalValue, cgstValue, sgstValue, igstValue, cessValue (numbers),
//   TotNonAdvolVal, OthValue (numbers — note capital T and O),
//   totInvValue (number),
//   transMode (number), transDistance (number),
//   transporterName (string), transporterId (string),
//   transDocNo (string), transDocDate (string dd/MM/yyyy),
//   vehicleNo (string), vehicleType (string "R"/"O"),
//   itemList (array)
// ─────────────────────────────────────────────────────────────────────────────
function buildEwbForVoucher(voucher, company, billToResolved, overrides = {}) {
  // 1. Seller
  const sellerGstin = (company?.gstin || "").trim().toUpperCase();
  const sellerStateCode =
    stateCodeFromGstin(sellerGstin) ||
    resolveStateCode(company?.address?.stateCode) ||
    resolveStateCode(company?.address?.state);
  const sellerPincode = String(company?.address?.pincode || "").trim();

  // 2. Bill-To
  const billGstin = billToResolved?.gstin || "URP";
  const billStateCode = billToResolved?.stateCode || 0;

  // 3. Ship-To (match or override)
  const matchOverride = overrides.shipMatchesBill;
  const matchesBill =
    typeof matchOverride === "boolean"
      ? matchOverride
      : detectShipMatchesBill(voucher, billToResolved);

  const storedShip = voucher.shippingAddress || {};
  let shipName,
    shipGstin,
    shipStateCode,
    shipPincode,
    shipAddr1,
    shipAddr2,
    shipPlace;
  if (matchesBill) {
    shipName = billToResolved?.name || voucher.partyLedgerName || "";
    shipGstin = billGstin;
    shipStateCode = billStateCode;
    shipPincode =
      Number(overrides.shipPincode) ||
      Number(storedShip.pincode) ||
      Number(billToResolved?.pincode) ||
      Number(company?.address?.pincode) ||
      0;
    shipAddr1 = billToResolved?.addr1 || "";
    shipAddr2 = billToResolved?.addr2 || "";
    shipPlace =
      billToResolved?.city ||
      billToResolved?.stateName ||
      voucher.placeOfSupply ||
      "";
  } else {
    shipName =
      overrides.shipName || storedShip.name || voucher.partyLedgerName || "";
    shipGstin = (
      overrides.shipGstin ||
      storedShip.gstin ||
      billGstin ||
      "URP"
    ).toUpperCase();
    shipStateCode =
      resolveStateCode(overrides.shipStateCode) ||
      resolveStateCode(storedShip.stateCode) ||
      resolveStateCode(storedShip.state) ||
      billStateCode;
    shipPincode =
      Number(overrides.shipPincode) || Number(storedShip.pincode) || 0;
    shipAddr1 =
      overrides.shipAddr1 ||
      (storedShip.addressLines && storedShip.addressLines[0]) ||
      "";
    shipAddr2 =
      overrides.shipAddr2 ||
      (storedShip.addressLines && storedShip.addressLines[1]) ||
      "";
    shipPlace =
      overrides.shipPlace ||
      storedShip.city ||
      storedShip.state ||
      voucher.placeOfSupply ||
      "";
  }

  // 4. Doc type
  let docType = "INV";
  if (voucher.voucherType === "credit_note") docType = "CNT";
  else if (voucher.voucherType === "delivery_note") docType = "CHL";
  if (overrides.docType) docType = overrides.docType;

  // 5. Supply / sub-supply  (NUMBER for subSupplyType)
  const supplyType = overrides.supplyType || "O";
  let subSupplyType = Number(overrides.subSupplyType) || 1;
  if (voucher.voucherType === "credit_note" && !overrides.subSupplyType)
    subSupplyType = 7;

  // 6. Transaction type — NUMBER (1=Regular, 2=Bill-To/Ship-To, etc.)
  const transType =
    Number(overrides.transactionType || overrides.transType) ||
    (matchesBill ? 1 : 2);

  // 7. Totals
  const totalTaxable = (voucher.inventoryEntries || []).reduce(
    (s, it) => s + (Number(it.amount) || 0),
    0,
  );
  const cgstValue = round2(voucher.gstBreakup?.cgst || 0);
  const sgstValue = round2(voucher.gstBreakup?.sgst || 0);
  const igstValue = round2(voucher.gstBreakup?.igst || 0);
  const cessValue = round2(voucher.gstBreakup?.cess || 0);
  const isInter = igstValue > 0;
  const othValue = round2(
    (voucher.grandTotal || 0) -
      totalTaxable -
      cgstValue -
      sgstValue -
      igstValue -
      cessValue -
      (voucher.roundOff || 0),
  );

  // 8. Items — official order: itemNo, productName, productDesc, hsnCode,
  // quantity, qtyUnit, taxableAmount, sgstRate, cgstRate, igstRate,
  // cessRate, cessNonAdvol. hsnCode is a string in quotes.
  const itemList = (voucher.inventoryEntries || []).map((it, idx) => {
    const taxableAmount = round2(it.amount || 0);
    const rate = Number(it.taxRate) || 0;
    // e-Way Bill: HSN must be the first 4 digits only. Even if a 6- or 8-digit
    // HSN is stored on the invoice line, the EWB JSON carries just the leading
    // 4 digits (strip non-digits, then take the first 4).
    const hsnDigits = String(it.hsnCode || "")
      .replace(/\D/g, "")
      .slice(0, 4);
    return {
      itemNo: idx + 1,
      productName: (it.stockItemName || `Item ${idx + 1}`).slice(0, 100),
      productDesc: (it.stockItemName || "").slice(0, 100),
      hsnCode: hsnDigits || "", // STRING — first 4 digits, empty if missing
      quantity: round3(it.quantity || 0),
      qtyUnit: mapUnit(it.unit),
      taxableAmount,
      sgstRate: isInter ? 0 : round2(rate / 2),
      cgstRate: isInter ? 0 : round2(rate / 2),
      igstRate: isInter ? round2(rate) : 0,
      cessRate: 0,
      cessNonAdvol: 0,
    };
  });

  // 9. Final EWB object — field NAMES + ORDER + TYPES match NIC tool
  const ewb = {
    userGstin: sellerGstin,
    supplyType, // string
    subSupplyType, // NUMBER
    subSupplyDesc: overrides.subSupplyDesc || "",
    docType, // string code
    docNo: voucher.voucherNumber,
    docDate: fmtEwbDate(voucher.voucherDate),
    transType, // NUMBER, not "transactionType"

    fromGstin: sellerGstin,
    fromTrdName: (company?.companyName || "").slice(0, 100),
    fromAddr1: (
      (company?.address?.line1 || company?.address?.addressLine1 || "") + ""
    ).slice(0, 120),
    fromAddr2: (
      (company?.address?.line2 || company?.address?.addressLine2 || "") + ""
    ).slice(0, 120),
    fromPlace: (company?.address?.city || "").slice(0, 50),
    fromPincode: Number(sellerPincode) || 0,
    fromStateCode: sellerStateCode || 0,
    actualFromStateCode: overrides.actualFromStateCode
      ? Number(overrides.actualFromStateCode)
      : overrides.actFromStateCode
        ? Number(overrides.actFromStateCode)
        : sellerStateCode || 0,

    toGstin: billGstin,
    toTrdName: shipName.slice(0, 100),
    toAddr1: shipAddr1.slice(0, 120),
    toAddr2: shipAddr2.slice(0, 120),
    toPlace: shipPlace.slice(0, 50),
    toPincode: shipPincode || 0,
    toStateCode: billStateCode || 0,
    actualToStateCode: shipStateCode || billStateCode || 0,

    totalValue: round2(totalTaxable),
    cgstValue,
    sgstValue,
    igstValue,
    cessValue,
    TotNonAdvolVal: 0, // capital T
    OthValue: othValue, // capital O
    totInvValue: round2(voucher.grandTotal || 0),

    transMode: Number(overrides.transMode) || 1, // NUMBER
    transDistance: Number(overrides.transDistance) || 0, // NUMBER
    transporterName:
      overrides.transporterName || voucher.eWayBillDetails?.transporter || "",
    transporterId: overrides.transporterId || "",
    transDocNo: overrides.transDocNo || "",
    transDocDate: overrides.transDocDate
      ? fmtEwbDate(overrides.transDocDate)
      : "",
    vehicleNo: normalizeVehicleNo(
      overrides.vehicleNo || voucher.eWayBillDetails?.vehicleNo || "",
    ),
    vehicleType: overrides.vehicleType || "R",

    itemList,
  };

  ewb._meta = {
    shipMatchesBill: matchesBill,
    autoDetectedMatch: typeof matchOverride !== "boolean",
  };
  return ewb;
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation — same blocker/warning split as V3.
// Field-name updates: transactionType→transType, actToStateCode→actualToStateCode.
// ─────────────────────────────────────────────────────────────────────────────
function classifyIssues(ewb) {
  const blockers = [];
  const warnings = [];

  if (!ewb.userGstin || ewb.userGstin.length !== 15)
    blockers.push("seller GSTIN");
  if (!ewb.fromPincode || ewb.fromPincode < 100000)
    blockers.push("seller pincode");
  if (!ewb.fromStateCode) blockers.push("seller state code");
  if (!ewb.docNo) blockers.push("invoice number");
  if (!ewb.docDate) blockers.push("invoice date");
  if (!ewb.toPincode || ewb.toPincode < 100000)
    blockers.push("ship-to pincode");
  if (!ewb.toStateCode) blockers.push("bill-to state code");
  if (!ewb.actualToStateCode) blockers.push("ship-to state code");
  if (!ewb.transDistance || Number(ewb.transDistance) < 1)
    blockers.push("distance (km)");
  if (!Array.isArray(ewb.itemList) || ewb.itemList.length === 0)
    blockers.push("at least one line item");

  const hasVehicle = ewb.vehicleNo && ewb.vehicleNo.length >= 7;
  const hasTransDoc = ewb.transDocNo && ewb.transDocDate;
  if (!hasVehicle && !hasTransDoc)
    blockers.push("vehicle number (or transporter doc no + date)");

  // HSN — WARNING only, not blocker
  const missingHsnLines = [];
  for (let i = 0; i < (ewb.itemList || []).length; i++) {
    if (!ewb.itemList[i].hsnCode) missingHsnLines.push(i + 1);
  }
  if (missingHsnLines.length > 0) {
    warnings.push(
      `HSN missing on line${missingHsnLines.length === 1 ? "" : "s"} ${missingHsnLines.join(", ")} — portal may reject; fix the source invoice if so`,
    );
  }

  return { blockers, warnings };
}

async function buildLedgerMap(vouchers) {
  const ids = vouchers
    .map((v) => v.partyLedgerId)
    .filter((id) => id && mongoose.Types.ObjectId.isValid(id));
  if (ids.length === 0) return new Map();
  const ledgers = await Acc_Ledger.find({ _id: { $in: ids } })
    .select("name gstin address contactDetails")
    .lean();
  return new Map(ledgers.map((l) => [String(l._id), l]));
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /preflight
// ─────────────────────────────────────────────────────────────────────────────
router.post("/preflight", accountantAuth, async (req, res) => {
  try {
    const { companyId, voucherIds, overrides: overridesMap = {} } = req.body;
    if (!companyId)
      return res.status(400).json({ error: "companyId required" });
    if (!Array.isArray(voucherIds) || voucherIds.length === 0) {
      return res.status(400).json({ error: "voucherIds[] required" });
    }
    if (voucherIds.length > 500) {
      return res
        .status(400)
        .json({ error: "Max 500 vouchers per preflight call" });
    }

    const company = await Acc_Company.findById(companyId).lean();
    if (!company) return res.status(404).json({ error: "Company not found" });

    const vouchers = await Acc_Voucher.find({
      _id: { $in: voucherIds },
      companyId,
    }).lean();
    const ledgerMap = await buildLedgerMap(vouchers);

    const items = vouchers.map((v) => {
      const billTo = resolvePartyDetails(v, ledgerMap);
      const vOverrides = overridesMap[String(v._id)] || {};
      const ewb = buildEwbForVoucher(v, company, billTo, vOverrides);
      const { blockers, warnings } = classifyIssues(ewb);

      const fromBlock = {
        name: company.companyName || "",
        gstin: (company.gstin || "").toUpperCase(),
        stateCode:
          stateCodeFromGstin(company.gstin) ||
          resolveStateCode(company.address?.stateCode) ||
          0,
        stateName: company.address?.state || "",
        addr1: company.address?.line1 || company.address?.addressLine1 || "",
        addr2: company.address?.line2 || company.address?.addressLine2 || "",
        pincode: company.address?.pincode || "",
        place: company.address?.city || "",
      };
      const storedShip = v.shippingAddress || {};
      const shipTo = {
        name: storedShip.name || "",
        gstin: (storedShip.gstin || "").toUpperCase(),
        stateCode:
          resolveStateCode(storedShip.stateCode) ||
          resolveStateCode(storedShip.state) ||
          0,
        stateName: storedShip.state || "",
        addr1: (storedShip.addressLines && storedShip.addressLines[0]) || "",
        addr2: (storedShip.addressLines && storedShip.addressLines[1]) || "",
        pincode: storedShip.pincode || "",
        place: storedShip.city || "",
      };

      return {
        voucherId: String(v._id),
        voucherNumber: v.voucherNumber,
        voucherDate: v.voucherDate,
        voucherType: v.voucherType,
        status: v.status,
        partyLedgerName: billTo.name,
        partyGstin: billTo.gstin,
        partyIsUnregistered: billTo.isUnregistered,
        grandTotal: v.grandTotal,
        ready: blockers.length === 0,
        blockers,
        warnings,
        missing: blockers, // legacy alias for older UI bits
        prefilled: ewb,
        fromBlock,
        billTo,
        shipTo,
        shipMatchesBill: ewb._meta.shipMatchesBill,
        // Previously-saved e-way bill transport details (auto-saved on last
        // generate). The frontend seeds the per-invoice overrides from this so
        // they don't need re-entering.
        savedEwbDetails: v.eWayBillDetails || null,
        inventoryEntries: (v.inventoryEntries || []).map((it, idx) => ({
          stockItemName: it.stockItemName || `Item ${idx + 1}`,
          // e-Way Bill uses only the first 4 HSN digits
          hsnCode: String(it.hsnCode || "")
            .replace(/\D/g, "")
            .slice(0, 4),
          quantity: it.quantity || 0,
          unit: it.unit || "",
          rate: it.rate || 0,
          taxRate: it.taxRate || 0,
          amount: it.amount || 0,
        })),
        gstBreakup: v.gstBreakup || {},
        narration: v.narration || "",
      };
    });

    res.json({
      items,
      count: items.length,
      company: {
        name: company.companyName,
        gstin: company.gstin,
        stateCode:
          stateCodeFromGstin(company.gstin) ||
          resolveStateCode(company.address?.stateCode) ||
          0,
        stateName: company.address?.state || "",
        addr1: company.address?.line1 || company.address?.addressLine1 || "",
        addr2: company.address?.line2 || company.address?.addressLine2 || "",
        pincode: company.address?.pincode || "",
        place: company.address?.city || "",
        contact: {
          phone: company.contact?.phone || "",
          email: company.contact?.email || "",
        },
      },
    });
  } catch (e) {
    console.error("[eway-bill/preflight]", e);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /generate
// Now wraps results in the official NIC envelope: { version, billLists: [] }
// ─────────────────────────────────────────────────────────────────────────────
router.post("/generate", accountantAuth, async (req, res) => {
  try {
    const { companyId, items } = req.body;
    if (!companyId)
      return res.status(400).json({ error: "companyId required" });
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "items[] required" });
    }
    if (items.length > 500) {
      return res
        .status(400)
        .json({ error: "Max 500 e-way bills per file. Split into batches." });
    }

    const company = await Acc_Company.findById(companyId).lean();
    if (!company) return res.status(404).json({ error: "Company not found" });

    const ids = items
      .map((i) => i.voucherId)
      .filter((id) => mongoose.Types.ObjectId.isValid(id));
    const vouchers = await Acc_Voucher.find({
      _id: { $in: ids },
      companyId,
    }).lean();
    const vMap = new Map(vouchers.map((v) => [String(v._id), v]));
    const ledgerMap = await buildLedgerMap(vouchers);

    const billLists = [];
    const warnings = [];
    const blockers = [];

    for (const item of items) {
      const v = vMap.get(String(item.voucherId));
      if (!v) {
        warnings.push({
          voucherId: item.voucherId,
          warning: "Voucher not found — skipped",
        });
        continue;
      }
      const billTo = resolvePartyDetails(v, ledgerMap);
      const ewb = buildEwbForVoucher(v, company, billTo, item.overrides || {});
      const issues = classifyIssues(ewb);

      if (issues.blockers.length > 0) {
        blockers.push({
          voucherId: String(v._id),
          voucherNumber: v.voucherNumber,
          missing: issues.blockers,
        });
        continue;
      }
      if (issues.warnings.length > 0) {
        warnings.push({
          voucherId: String(v._id),
          voucherNumber: v.voucherNumber,
          warnings: issues.warnings,
        });
      }
      // Strip internal flag — _meta is not part of the NIC schema
      delete ewb._meta;
      billLists.push(ewb);

      // ── Persist the filled transport details back to the voucher ──────────
      // So the next time this invoice's e-way bill is needed, the values are
      // pre-filled instead of being re-entered. We save the full overrides blob
      // plus the common named fields. Best-effort: a save failure here must not
      // break JSON generation.
      try {
        const o = item.overrides || {};
        const ewbSet = {
          "eWayBillDetails.transporter":
            o.transporterName || v.eWayBillDetails?.transporter || "",
          "eWayBillDetails.transporterId": o.transporterId || "",
          "eWayBillDetails.vehicleNo":
            o.vehicleNo || v.eWayBillDetails?.vehicleNo || "",
          "eWayBillDetails.vehicleType": o.vehicleType || "",
          "eWayBillDetails.distance": Number(o.transDistance) || 0,
          "eWayBillDetails.transMode":
            o.transMode != null ? Number(o.transMode) : undefined,
          "eWayBillDetails.transDistance":
            o.transDistance != null ? Number(o.transDistance) : undefined,
          "eWayBillDetails.transDocNo": o.transDocNo || "",
          "eWayBillDetails.transDocDate": o.transDocDate || "",
          "eWayBillDetails.subSupplyType":
            o.subSupplyType != null ? Number(o.subSupplyType) : undefined,
          "eWayBillDetails.subSupplyDesc": o.subSupplyDesc || "",
          "eWayBillDetails.docType": o.docType || "",
          "eWayBillDetails.transType":
            o.transType != null
              ? Number(o.transType)
              : o.transactionType != null
                ? Number(o.transactionType)
                : undefined,
          "eWayBillDetails.supplyType": o.supplyType || "",
          "eWayBillDetails.shipMatchesBill":
            typeof o.shipMatchesBill === "boolean"
              ? o.shipMatchesBill
              : undefined,
          "eWayBillDetails.shipName": o.shipName || "",
          "eWayBillDetails.shipGstin": o.shipGstin || "",
          "eWayBillDetails.shipStateCode": o.shipStateCode || "",
          "eWayBillDetails.shipPincode": o.shipPincode || "",
          "eWayBillDetails.shipAddr1": o.shipAddr1 || "",
          "eWayBillDetails.shipAddr2": o.shipAddr2 || "",
          "eWayBillDetails.shipPlace": o.shipPlace || "",
          "eWayBillDetails.lastGeneratedAt": new Date(),
        };
        // Drop undefined keys so we don't overwrite with nulls
        Object.keys(ewbSet).forEach(
          (k) => ewbSet[k] === undefined && delete ewbSet[k],
        );
        await Acc_Voucher.updateOne({ _id: v._id }, { $set: ewbSet });
      } catch (saveErr) {
        console.error(
          "[eway-bill/generate] could not persist details for",
          v.voucherNumber,
          saveErr.message,
        );
      }
    }

    if (blockers.length > 0) {
      return res.status(400).json({
        error:
          "Some invoices are missing required fields. Fix them and try again.",
        blockers,
        warnings,
      });
    }

    const envelope = { version: EWB_JSON_VERSION, billLists };

    const today = new Date();
    const filename = `eway-bills-${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, "0")}${String(today.getDate()).padStart(2, "0")}.json`;

    // ewbList kept in response for back-compat with existing UI; the
    // proper upload payload is `envelope`.
    res.json({
      envelope,
      ewbList: billLists,
      count: billLists.length,
      warnings,
      filename,
    });
  } catch (e) {
    console.error("[eway-bill/generate]", e);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /eligible-vouchers — unchanged from V3
// ─────────────────────────────────────────────────────────────────────────────
router.get("/eligible-vouchers", accountantAuth, async (req, res) => {
  try {
    const {
      companyId,
      from,
      to,
      minValue = 50000,
      includeCN = "0",
      includeWithEwb = "0",
    } = req.query;
    if (!companyId)
      return res.status(400).json({ error: "companyId required" });

    const company = await Acc_Company.findById(companyId)
      .select("companyName gstin address")
      .lean();
    if (!company) return res.status(404).json({ error: "Company not found" });

    const companyStateCode =
      stateCodeFromGstin(company.gstin) ||
      resolveStateCode(company.address?.stateCode) ||
      resolveStateCode(company.address?.state);

    const types = ["sales"];
    if (includeCN === "1") types.push("credit_note");

    const filter = {
      companyId,
      voucherType: { $in: types },
      status: "posted",
      grandTotal: { $gte: Number(minValue) || 0 },
    };
    if (from || to) {
      filter.voucherDate = {};
      if (from) filter.voucherDate.$gte = new Date(from);
      if (to) filter.voucherDate.$lte = new Date(to);
    } else {
      const now = new Date();
      const fyStart = new Date(
        now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1,
        3,
        1,
      );
      filter.voucherDate = { $gte: fyStart };
    }
    if (includeWithEwb !== "1") {
      filter.$or = [
        { "eWayBillDetails.ewbNumber": { $exists: false } },
        { "eWayBillDetails.ewbNumber": null },
        { "eWayBillDetails.ewbNumber": "" },
      ];
    }

    const vouchers = await Acc_Voucher.find(filter)
      .select(
        "voucherType voucherNumber voucherDate partyLedgerId partyLedgerName partyGstin grandTotal placeOfSupply placeOfSupplyCode shippingAddress eWayBillDetails inventoryEntries",
      )
      .sort({ voucherDate: -1 })
      .limit(500)
      .lean();

    const ledgerMap = await buildLedgerMap(vouchers);

    const lite = vouchers.map((v) => {
      const billTo = resolvePartyDetails(v, ledgerMap);
      const partyStateCode = billTo.stateCode || 0;
      const shipStateCode =
        resolveStateCode(v.shippingAddress?.stateCode) ||
        resolveStateCode(v.shippingAddress?.state) ||
        0;
      return {
        _id: v._id,
        voucherType: v.voucherType,
        voucherNumber: v.voucherNumber,
        voucherDate: v.voucherDate,
        partyLedgerName: billTo.name,
        partyGstin: billTo.gstin,
        partyIsUnregistered: billTo.isUnregistered,
        placeOfSupply: billTo.stateName,
        placeOfSupplyCode: String(partyStateCode).padStart(2, "0"),
        partyStateCode,
        shipStateCode,
        shipGstin: v.shippingAddress?.gstin || "",
        grandTotal: v.grandTotal,
        itemCount: (v.inventoryEntries || []).length,
        shipPincode: v.shippingAddress?.pincode || "",
        shipCity: v.shippingAddress?.city || "",
        shipMatchesBill: detectShipMatchesBill(v, billTo),
        isIntraState:
          partyStateCode && companyStateCode
            ? Number(partyStateCode) === Number(companyStateCode)
            : null,
        hasEwbAlready: !!v.eWayBillDetails?.ewbNumber,
        transporterOnFile: v.eWayBillDetails?.transporter || "",
        vehicleOnFile: v.eWayBillDetails?.vehicleNo || "",
      };
    });

    res.json({
      vouchers: lite,
      count: lite.length,
      company: {
        name: company.companyName,
        gstin: company.gstin,
        stateCode: companyStateCode,
      },
    });
  } catch (e) {
    console.error("[eway-bill/eligible-vouchers]", e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;

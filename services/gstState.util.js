// services/gstState.util.js
//
// GST STATE-CODE UTILITIES (open tasks #2 + #3)
// ─────────────────────────────────────────────────────────────────────────────
// The first 2 digits of every GSTIN are the GST State Code (per the official
// state-code list). This module is the single source of truth for:
//
//   • stateFromGstin(gstin)      → "Odisha"  (full state name from a GSTIN)
//   • stateCodeFromGstin(gstin)  → "21"      (2-digit code from a GSTIN)
//   • codeFromStateName(name)    → "21"      (code from a typed state name)
//   • applyGstAutoState(ledger)  → ledger with contactDetails + address.*
//                                   backfilled from its stored GSTIN
//
// WHY THIS EXISTS
// ───────────────
// Task #3: party ledgers imported from Tally (or created by hand) often have
// a GSTIN but no state / stateCode filled in. The invoice & voucher forms
// decide CGST+SGST (intra-state) vs IGST (inter-state) by comparing the
// company's stateCode with the party's stateCode. With the party stateCode
// blank, the form either (a) wrongly defaults to intra-state, or (b) hard-
// blocks the user with "Customer has GSTIN but no state code".
//
// Deriving the state/stateCode from the GSTIN's leading 2 digits removes both
// problems WITHOUT a data migration — it is computed on read.
//
// SHAPE NOTE
// ──────────
// Acc_Ledger stores party address under `contactDetails.{state,stateCode,...}`.
// Several frontend forms (sales/purchase/credit/debit voucher forms) read the
// party as `selectedCustomer.address.{state,stateCode}` and `.gstin`. To keep
// those forms working without touching every one of them, applyGstAutoState()
// ALSO mirrors the resolved address into a top-level `address` object and a
// top-level `gstin`. Existing values are never overwritten — auto-detection
// only FILLS BLANKS, so a manually-entered stateCode always wins.

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

// Reverse map (lowercased state name → code) for typed-name resolution.
const STATE_NAME_TO_CODE = {};
for (const [code, nm] of Object.entries(GST_STATE_CODES)) {
  STATE_NAME_TO_CODE[nm.toLowerCase()] = code;
}
// A couple of common alternate spellings accountants type by hand.
const STATE_ALIASES = {
  orissa: "21",
  pondicherry: "34",
  uttaranchal: "05",
  "andhra pradesh": "37",
};
for (const [alias, code] of Object.entries(STATE_ALIASES)) {
  if (!STATE_NAME_TO_CODE[alias]) STATE_NAME_TO_CODE[alias] = code;
}

function stateCodeFromGstin(gstin) {
  if (!gstin) return null;
  const code = String(gstin).trim().slice(0, 2);
  return GST_STATE_CODES[code] ? code : null;
}

function stateFromGstin(gstin) {
  const code = stateCodeFromGstin(gstin);
  return code ? GST_STATE_CODES[code] : null;
}

function codeFromStateName(stateName) {
  if (!stateName) return null;
  return STATE_NAME_TO_CODE[String(stateName).trim().toLowerCase()] || null;
}

// Derive the best { state, stateCode } pair from whatever is available:
// an explicit stateCode wins, then a derivation from GSTIN, then mapping a
// typed state name to its code. Never throws.
function resolveState({ gstin, state, stateCode } = {}) {
  let code = stateCode ? String(stateCode).trim() : "";
  let name = state ? String(state).trim() : "";

  if (!code && gstin) code = stateCodeFromGstin(gstin) || "";
  if (!code && name) code = codeFromStateName(name) || "";
  if (!name && code && GST_STATE_CODES[code]) name = GST_STATE_CODES[code];
  if (!name && gstin) name = stateFromGstin(gstin) || "";

  return { state: name || null, stateCode: code || null };
}

// Backfill a single lean Acc_Ledger object (mutates a copy is the caller's
// job; this mutates in place for speed on large lists, callers pass .lean()
// docs which are plain objects). Returns the same object for chaining.
function applyGstAutoState(ledger) {
  if (!ledger || typeof ledger !== "object") return ledger;

  const cd = ledger.contactDetails || {};
  const gstin = ledger.gstin || cd.gstin || "";

  const resolved = resolveState({
    gstin,
    state: cd.state,
    stateCode: cd.stateCode,
  });

  // Fill blanks only — manual entry always wins.
  ledger.contactDetails = {
    ...cd,
    state: cd.state || resolved.state || null,
    stateCode: cd.stateCode || resolved.stateCode || null,
  };

  // Mirror into the `address` shape the voucher/invoice forms expect, again
  // without clobbering anything the forms or other code already set.
  const addr = ledger.address || {};
  ledger.address = {
    ...addr,
    line1: addr.line1 || cd.address || null,
    city: addr.city || cd.city || null,
    state: addr.state || ledger.contactDetails.state || null,
    stateCode: addr.stateCode || ledger.contactDetails.stateCode || null,
    pincode: addr.pincode || cd.pincode || null,
    country: addr.country || cd.country || "India",
  };

  // Surface a top-level gstin too (forms read selectedCustomer.gstin).
  if (!ledger.gstin && gstin) ledger.gstin = gstin;

  // A small flag so the UI can show "state auto-detected from GSTIN".
  ledger.stateAutoDetected = !cd.stateCode && !!resolved.stateCode && !!gstin;

  return ledger;
}

module.exports = {
  GST_STATE_CODES,
  STATE_NAME_TO_CODE,
  stateFromGstin,
  stateCodeFromGstin,
  codeFromStateName,
  resolveState,
  applyGstAutoState,
};

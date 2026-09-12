"use strict";

// ── Landed-cost allocation — pure math (V2) ──────────────────────────────────
//
// Distributes an eligible landed-cost charge (inward freight, transit
// insurance, customs, clearing) from a posted supplier Purchase Voucher across
// the goods actually received, by RECEIPT BASE VALUE:
//
//   line allocation = total eligible landed cost
//                     × target receipt line base value
//                     ÷ total target base value
//
//   base value = received quantity × recorded base unit cost  (NOT ordered qty)
//
// Deterministic to the paise, with the final rounding remainder placed on the
// last positive-base target so the parts sum EXACTLY to the entered charge.
// This module does no I/O and knows nothing about vouchers — it only allocates.

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const isPosFinite = (n) => typeof n === "number" && Number.isFinite(n) && n > 0;
const isFiniteNum = (n) => typeof n === "number" && Number.isFinite(n);

// Only receipt-base-value allocation is supported in V2. Weight/volume bases are
// declared but UNAVAILABLE — never offered as if they worked, because there is
// no weight/volume data to allocate by.
const ALLOCATION_BASES = Object.freeze([
  { value: "receipt_base_value", label: "Receipt base value", available: true },
  { value: "weight", label: "Weight", available: false, reason: "No weight data is recorded." },
  { value: "volume", label: "Volume", available: false, reason: "No volume data is recorded." },
]);

const REFUSAL = Object.freeze({
  INVALID_CHARGE: "INVALID_CHARGE",
  NO_TARGETS: "NO_TARGETS",
  ZERO_TOTAL_BASE: "ZERO_TOTAL_BASE",
  UNSUPPORTED_BASIS: "UNSUPPORTED_BASIS",
});

/**
 * Allocate a landed-cost charge across receipt targets by base value.
 *
 * @param {object} args
 * @param {number} args.totalCharge  positive, finite rupee amount
 * @param {Array<{key:string, baseValue:number, receivedQuantity?:number}>} args.targets
 *   base value = receivedQuantity × baseUnitCost; a target with an explicit 0 /
 *   missing base value cannot participate.
 * @param {string} [args.basis="receipt_base_value"]
 * @returns {{ok:true, basis, totalCharge, allocations:Array<{key, allocatedAmount, allocatedPerUnit}>}
 *          | {ok:false, reason, message}}
 */
function allocateByBaseValue({ totalCharge, targets, basis = "receipt_base_value" } = {}) {
  const supported = ALLOCATION_BASES.find((b) => b.value === basis && b.available);
  if (!supported) {
    return { ok: false, reason: REFUSAL.UNSUPPORTED_BASIS, message: `Allocation basis "${basis}" is not available.` };
  }
  if (!isPosFinite(totalCharge)) {
    return { ok: false, reason: REFUSAL.INVALID_CHARGE, message: "The charge amount must be a positive number." };
  }
  const rows = Array.isArray(targets) ? targets : [];
  if (rows.length === 0) {
    return { ok: false, reason: REFUSAL.NO_TARGETS, message: "There are no received lines to allocate to." };
  }

  // Only targets with a positive, finite base value participate. An explicit
  // zero base value is kept but gets nothing — it cannot take a share of a
  // value-based split.
  const participating = rows.filter((t) => isPosFinite(t.baseValue));
  const totalBase = participating.reduce((s, t) => s + t.baseValue, 0);
  if (participating.length === 0 || totalBase <= 0) {
    // Every selected target has zero / missing / indeterminate base value —
    // refuse rather than divide equally by quantity across who-knows-what units.
    return {
      ok: false,
      reason: REFUSAL.ZERO_TOTAL_BASE,
      message: "None of the selected receipts has a base value to allocate against.",
    };
  }

  // Work in paise so the parts sum EXACTLY. Every positive-base target but the
  // last is rounded; the last positive-base target absorbs the remainder.
  const totalPaise = Math.round(totalCharge * 100);
  const lastKey = participating[participating.length - 1].key;
  let assignedPaise = 0;
  const byKey = new Map();
  for (let i = 0; i < participating.length; i += 1) {
    const t = participating[i];
    let paise;
    if (i === participating.length - 1) {
      paise = totalPaise - assignedPaise; // remainder on the last deterministic target
    } else {
      paise = Math.round((totalPaise * t.baseValue) / totalBase);
      assignedPaise += paise;
    }
    byKey.set(t.key, paise);
  }

  const allocations = rows.map((t) => {
    const paise = byKey.get(t.key) || 0;
    const allocatedAmount = round2(paise / 100);
    const qty = isPosFinite(t.receivedQuantity) ? t.receivedQuantity : null;
    return {
      key: t.key,
      allocatedAmount,
      allocatedPerUnit: qty ? round2(allocatedAmount / qty) : (allocatedAmount === 0 ? 0 : null),
      participated: byKey.has(t.key) && (isPosFinite(t.baseValue)),
    };
  });

  return { ok: true, basis, totalCharge: round2(totalCharge), totalBase: round2(totalBase), allocations, lastKey };
}

// The eligible acquisition-cost hints and the always-excluded categories. These
// guide Accounting's SELECTION; the system never auto-includes a charge line.
const ELIGIBLE_HINTS = Object.freeze([
  "inward freight", "freight inward", "transit insurance", "insurance",
  "customs", "duty", "clearing", "handling",
]);
const EXCLUDED_HINTS = Object.freeze([
  "gst", "igst", "cgst", "sgst", "input tax", "tax credit",
  "payment", "bank charge", "penalty", "late fee", "interest",
  "round off", "discount",
]);

// A soft classification used ONLY to pre-hint the UI. It never auto-selects and
// never auto-includes — Accounting explicitly chooses. Recoverable tax and the
// other excluded categories are flagged so they are not picked by habit.
function classifyChargeHint(description = "") {
  const d = String(description).toLowerCase();
  if (EXCLUDED_HINTS.some((h) => d.includes(h))) return "excluded";
  if (ELIGIBLE_HINTS.some((h) => d.includes(h))) return "eligible";
  return "unknown"; // Accounting decides; entered explicitly with confirmation
}

module.exports = {
  allocateByBaseValue,
  classifyChargeHint,
  ALLOCATION_BASES,
  ELIGIBLE_HINTS,
  EXCLUDED_HINTS,
  REFUSAL,
};

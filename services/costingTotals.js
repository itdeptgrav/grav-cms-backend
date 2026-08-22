// services/costingTotals.js
//
// Cost per piece, and the floor price, computed ON THE SERVER.
//
// WHY THIS EXISTS. The floor price used to be worked out in the browser —
// `cost / (1 - floor%)` inside CostingPanel — which meant the cost had to be on
// the wire for the floor to be displayable. Gating the columns in React while
// the endpoint still served the underlying rows was theatre: anyone could read
// the vendor prices out of the network tab.
//
// So the sensitive part is reduced here and only the RESULT crosses the wire.
// A salesperson without commercial access gets `{ costed: true, floorPrice }` —
// one number with no structure behind it. No vendor, no unit cost, no SAM, no
// cost per minute, and no cost per piece either.
//
// NATIVE ROWS (19 Aug 2026). Costing used to be read out of a CoWork
// spreadsheet workbook (formula cells, label-anchored row scanning); it is now
// plain `materials`/`operations` arrays stored directly on the Enquiry, so this
// is just the arithmetic — the same sum `lib/salesJourney/costingModel.js`'s
// `costTotals` does client-side, so the two can never disagree.
"use strict";

const num = (v) => {
  const n = Number(String(v ?? "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
};

/**
 * Every part of a product's costing → cost per piece and the floor.
 *
 * @param {object[]} parts one per contributor sheet (raw / operations / combined),
 *   each `{ materials?: {unitCost, consumption}[], operations?: {sam, rate}[] }`
 * @param {number} floorPercent the margin policy, e.g. 22
 */
function costingTotals(parts = [], floorPercent = 22) {
  let materials = 0;
  let operations = 0;
  let miscellaneous = 0;
  for (const p of parts) {
    if (!p) continue;
    for (const m of p.materials || []) materials += num(m.unitCost) * num(m.consumption);
    for (const o of p.operations || []) operations += num(o.sam) * num(o.rate);
    for (const x of p.miscellaneous || []) miscellaneous += num(x.price);
  }
  const costPerPiece = +(materials + operations + miscellaneous).toFixed(2);

  // The one number a non-commercial viewer may have: the lowest price this
  // product can be sold at and still clear the margin policy. It reveals no
  // structure — you cannot work backwards to a vendor from it.
  const pct = Math.min(99, Math.max(0, num(floorPercent)));
  const floorPrice = costPerPiece > 0 ? +(costPerPiece / (1 - pct / 100)).toFixed(2) : null;

  return {
    costed: costPerPiece > 0,
    costPerPiece,
    materials: +materials.toFixed(2),
    operations: +operations.toFixed(2),
    miscellaneous: +miscellaneous.toFixed(2),
    floorPrice,
    floorPercent: pct,
  };
}

module.exports = { costingTotals };

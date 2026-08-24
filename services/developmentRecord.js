// services/developmentRecord.js
//
// The proof behind "this style needs no development".
//
// A style raised from a registered product skips the tech sheet and the sample.
// That is a strong claim, and a claim nobody can check is worse than asking for
// the work — six months later there is no way to tell a deliberately waived
// style from one somebody forgot. So the stage shows its evidence.
//
// THE TEST IS NARROW ON PURPOSE: has this garment actually BEEN MADE?
//
// Only two things answer yes, and both are by-products of production rather
// than things anyone authors in advance:
//
//   1. A PRIOR STYLE for this same stock item that reached "approved". A
//      physical sample this factory made and Sales signed off. Nothing beats
//      it, and it names the journey and the date.
//   2. A MEASURED SAM. Operations with recorded seconds come from timing a real
//      garment on a real line; you cannot stopwatch something that does not
//      exist.
//
// Everything else is SUPPORTING — real, useful, and not proof:
//
//   • A costed bill of materials. Reclassified from strong on 22 Aug 2026: a
//     merchandiser can type a full BOM off a spec sheet for a garment nobody
//     has ever cut. It says what it would be made of, not that it was made.
//   • Measurements and reference pictures. Same problem, more so.
//
// The distinction decides whether Style & Sample is waived, so being generous
// here means waving unmade garments straight past R&D — which is the exact
// failure this file exists to prevent.

"use strict";

/**
 * @param {object}   p
 * @param {object}   p.stockItem   lean StockItem, or null
 * @param {Array}    [p.priorStyles]  earlier SampleStyles for this stock item
 * @returns {object} `{ registered, reference, evidence[], proven, gaps[] }`
 */
function buildDevelopmentRecord({ stockItem = null, priorStyles = [] } = {}) {
  if (!stockItem) {
    return {
      registered: false,
      reference: null,
      evidence: [],
      proven: false,
      gaps: ["This style was typed by hand, so it has no register entry to stand on."],
    };
  }

  const operations = Array.isArray(stockItem.operations) ? stockItem.operations : [];
  const seconds = operations.reduce((n, o) => n + (o.totalSeconds || 0), 0);
  const variants = Array.isArray(stockItem.variants) ? stockItem.variants : [];
  // The BOM lives per variant; the first variant that has one is representative
  // — they differ by size, not by what the garment is made of.
  const bom = variants.map((v) => (Array.isArray(v.rawItems) ? v.rawItems : [])).find((r) => r.length) || [];
  const bomCost = bom.reduce((n, r) => n + (r.quantity || 0) * (r.unitCost || 0), 0);
  const measurements = Array.isArray(stockItem.measurements) ? stockItem.measurements : [];
  const images = Array.isArray(stockItem.images) ? stockItem.images.filter(Boolean) : [];

  const approvedBefore = (priorStyles || []).filter((s) => s?.sample?.status === "approved");

  const evidence = [];

  if (approvedBefore.length) {
    const last = approvedBefore
      .slice()
      .sort((a, b) => new Date(b.sample.approvedAt || 0) - new Date(a.sample.approvedAt || 0))[0];
    evidence.push({
      key: "priorSample",
      strength: "strong",
      label: "Sampled and approved before",
      detail: [
        last.journeyRef ? `on ${last.journeyRef}` : null,
        last.sample.approvedAt ? new Date(last.sample.approvedAt).toISOString().slice(0, 10) : null,
        last.sample.rounds?.length ? `${last.sample.rounds.length} round${last.sample.rounds.length === 1 ? "" : "s"}` : null,
      ].filter(Boolean).join(" · "),
    });
  }

  if (operations.length && seconds > 0) {
    evidence.push({
      key: "sam",
      strength: "strong",
      label: `${operations.length} operations, ${Math.round((seconds / 60) * 100) / 100} min measured`,
      detail: "A measured SAM comes from timing a real garment, not from an estimate.",
    });
  } else if (operations.length) {
    evidence.push({
      key: "operations",
      strength: "weak",
      label: `${operations.length} operations listed`,
      detail: "No times recorded against them yet.",
    });
  }

  if (bom.length) {
    evidence.push({
      key: "bom",
      // SUPPORTING, not strong — see the header. A BOM can be authored for a
      // garment nobody has cut.
      strength: "supporting",
      label: `Bill of materials — ${bom.length} item${bom.length === 1 ? "" : "s"}`,
      detail: bomCost > 0 ? `Costed at ${Math.round(bomCost * 100) / 100} per piece.` : "No costs against the items yet.",
    });
  }

  if (measurements.length) {
    evidence.push({ key: "measurements", strength: "supporting", label: `${measurements.length} measurement points`, detail: null });
  }
  if (images.length) {
    evidence.push({ key: "images", strength: "supporting", label: `${images.length} picture${images.length === 1 ? "" : "s"} on the register`, detail: null });
  }

  // "Proven" needs at least one STRONG piece — a prior approved sample or a
  // measured SAM. Everything else describes an intention.
  const proven = evidence.some((e) => e.strength === "strong");

  const gaps = [];
  if (!approvedBefore.length) gaps.push("No earlier sample of this product was approved through this system.");
  if (!operations.length) gaps.push("The register has no operations for it.");
  if (!bom.length) gaps.push("The register has no bill of materials for it.");

  return {
    registered: true,
    reference: stockItem.reference || null,
    name: stockItem.name || null,
    category: stockItem.category || null,
    evidence,
    proven,
    gaps,
  };
}

module.exports = { buildDevelopmentRecord };

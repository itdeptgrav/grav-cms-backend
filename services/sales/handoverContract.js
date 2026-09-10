// services/sales/handoverContract.js
//
// THE SALES → MERCHANDISING HANDOVER CONTRACT, AS RULES.
//
// One module, imported by both sides, holding the parts of the contract that
// are pure logic rather than storage: what a delivery, a split and an
// allocation must satisfy, and exactly which Execution Units a valid
// projection produces.
//
// ── WHY BOTH SIDES IMPORT THE SAME FUNCTIONS ────────────────────────────────
// Sales validates at issue; Merchandising re-derives at acceptance. Those are
// two different moments in two different applications, and when each owned its
// own copy of the rule they drifted immediately: the producer reconciled
// splits and deliveries independently, so the receiver — reading the very same
// projection — built one set of units per axis and stored TWICE the confirmed
// quantity. Nobody wrote a wrong number; two implementations of one rule
// disagreed about what the number meant.
//
// This module carries no record and mutates nothing. Importing it across the
// boundary is reading the contract, not reaching into the other application's
// data — which is why the ownership test forbids model imports and not this.
//
// ── THE MULTI-AXIS PROBLEM, AND WHY `allocations[]` EXISTS ──────────────────
// `breakdown[]` says what the line is made of (colourways, size ranges).
// `deliveries[]` says when and where it ships. Each reconciles to the line
// total on its own. When BOTH have more than one row, they describe the same
// garments twice from two angles, and nothing in either says which colourway
// travels in which drop.
//
// Deriving units from both axes at once double-counts. Deriving from one
// silently discards the other. Guessing a mapping — spreading each split
// pro-rata across drops — invents quantities nobody confirmed and would put
// dates on tuples Sales never agreed to.
//
// So the mapping is asked for. `allocations[]` is Sales' explicit statement of
// how much of split X ships in drop Y; it references the two axes by their
// own identities and repeats nothing from them. Where a mapping is not needed
// — one split, or one drop — it is not required, because there is only one
// way to read the projection and asking would be ceremony.
"use strict";

const { fail } = require("../storePurchase/errors");

const str = (v) => String(v ?? "").trim();
const int = (v) => Number(v);

/** The only fields each nested contract row may carry. */
const DELIVERY_FIELDS = Object.freeze([
  "dropRef", "committedDeliveryDate", "quantity", "nominatedFactoryRef", "targetExFactoryDate",
]);
const BREAKDOWN_FIELDS = Object.freeze(["lineSplitRef", "attributes", "sizeRange", "quantity"]);
/* An allocation is a JOIN, not a third description of the garment: it names
   the two rows it connects and how many pieces. Attributes, dates and
   factories are read from the rows it references — repeating them here would
   create a second place for a date to be right or wrong. */
const ALLOCATION_FIELDS = Object.freeze(["allocationRef", "lineSplitRef", "dropRef", "quantity"]);

/* ═══ NORMALISATION ════════════════════════════════════════════════════════ */

/**
 * Validate the delivery commitments and reconcile them to the line total.
 *
 * Every drop carries a Sales-authored committed date. `targetExFactoryDate` is
 * stored only when Sales supplies one — never derived from the delivery date,
 * because "delivery minus an invented lead time" is a date nobody committed.
 */
function normaliseDeliveries(deliveries, totalQuantity) {
  if (!Array.isArray(deliveries) || deliveries.length === 0) {
    throw fail("VALIDATION", "At least one delivery commitment, with its committed date, is required.", { field: "deliveries" });
  }
  const out = deliveries.map((d, i) => {
    const date = new Date(d?.committedDeliveryDate);
    if (!d?.committedDeliveryDate || Number.isNaN(date.getTime())) {
      throw fail("VALIDATION", `Delivery ${i + 1} needs its committed delivery date.`, { field: "committedDeliveryDate", index: i });
    }
    const quantity = int(d?.quantity);
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw fail("VALIDATION", `Delivery ${i + 1} needs a positive quantity.`, { field: "quantity", index: i });
    }
    let target;
    if (d?.targetExFactoryDate !== undefined && d?.targetExFactoryDate !== null && d?.targetExFactoryDate !== "") {
      target = new Date(d.targetExFactoryDate);
      if (Number.isNaN(target.getTime())) {
        throw fail("VALIDATION", `Delivery ${i + 1} has a target ex-factory date that is not a date.`, { field: "targetExFactoryDate", index: i });
      }
    }
    return {
      dropRef: str(d.dropRef) || `DROP-${i + 1}`,
      committedDeliveryDate: date,
      quantity,
      ...(str(d.nominatedFactoryRef) ? { nominatedFactoryRef: str(d.nominatedFactoryRef) } : {}),
      ...(target ? { targetExFactoryDate: target } : {}),
    };
  });
  const sum = out.reduce((t, d) => t + d.quantity, 0);
  if (sum !== totalQuantity) {
    throw fail("VALIDATION",
      `The delivery quantities total ${sum}, and the confirmed line is ${totalQuantity}. They must reconcile exactly.`,
      { field: "deliveries", sum, totalQuantity });
  }
  const refs = out.map((d) => d.dropRef);
  if (new Set(refs).size !== refs.length) {
    throw fail("VALIDATION", "Each delivery drop needs its own reference.", { field: "deliveries" });
  }
  return out;
}

/** Validate the confirmed splits and reconcile them to the line total. */
function normaliseBreakdown(breakdown, totalQuantity) {
  if (!Array.isArray(breakdown) || breakdown.length === 0) return [];
  const out = breakdown.map((b, i) => {
    const quantity = int(b?.quantity);
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw fail("VALIDATION", `Split ${i + 1} needs a positive quantity.`, { field: "quantity", index: i });
    }
    return {
      lineSplitRef: str(b.lineSplitRef) || `SPLIT-${i + 1}`,
      attributes: (Array.isArray(b.attributes) ? b.attributes : [])
        .map((a) => ({ name: str(a?.name), value: str(a?.value) }))
        .filter((a) => a.name),
      ...(str(b.sizeRange) ? { sizeRange: str(b.sizeRange) } : {}),
      quantity,
    };
  });
  const sum = out.reduce((t, b) => t + b.quantity, 0);
  if (sum !== totalQuantity) {
    throw fail("VALIDATION",
      `The breakdown quantities total ${sum}, and the confirmed line is ${totalQuantity}. They must reconcile exactly.`,
      { field: "breakdown", sum, totalQuantity });
  }
  const refs = out.map((b) => b.lineSplitRef);
  if (new Set(refs).size !== refs.length) {
    throw fail("VALIDATION", "Each confirmed split needs its own reference.", { field: "breakdown" });
  }
  return out;
}

/** True when the projection genuinely has two axes and must be mapped. */
function needsAllocations(breakdown = [], deliveries = []) {
  return breakdown.length > 1 && deliveries.length > 1;
}

/**
 * Validate the split × drop mapping.
 *
 * Refused, each with the business reason rather than a schema complaint:
 * a missing mapping, a reference to a split or drop that does not exist, a
 * repeated allocation identity, the same split-and-drop pair stated twice, a
 * split or drop whose allocations do not sum to what Sales confirmed for it,
 * and a confirmed split or drop that no allocation mentions at all.
 */
function normaliseAllocations(allocations, breakdown, deliveries, totalQuantity) {
  if (!needsAllocations(breakdown, deliveries)) {
    if (Array.isArray(allocations) && allocations.length) {
      throw fail("VALIDATION",
        "This line has a single split or a single delivery, so it needs no allocation mapping.",
        { field: "allocations" });
    }
    return [];
  }

  if (!Array.isArray(allocations) || allocations.length === 0) {
    throw fail("VALIDATION",
      `This line is confirmed in ${breakdown.length} splits across ${deliveries.length} deliveries. `
      + "Say how much of each split ships in each delivery before handing it over.",
      { field: "allocations", splits: breakdown.length, drops: deliveries.length });
  }

  const splitByRef = new Map(breakdown.map((b) => [b.lineSplitRef, b]));
  const dropByRef = new Map(deliveries.map((d) => [d.dropRef, d]));

  const out = allocations.map((a, i) => {
    const lineSplitRef = str(a?.lineSplitRef);
    const dropRef = str(a?.dropRef);
    if (!splitByRef.has(lineSplitRef)) {
      throw fail("VALIDATION", `Allocation ${i + 1} names a split this line does not have.`,
        { field: "lineSplitRef", index: i, value: lineSplitRef });
    }
    if (!dropByRef.has(dropRef)) {
      throw fail("VALIDATION", `Allocation ${i + 1} names a delivery this line does not have.`,
        { field: "dropRef", index: i, value: dropRef });
    }
    const quantity = int(a?.quantity);
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw fail("VALIDATION", `Allocation ${i + 1} needs a positive quantity.`, { field: "quantity", index: i });
    }
    return {
      allocationRef: str(a?.allocationRef) || `ALLOC-${i + 1}`,
      lineSplitRef,
      dropRef,
      quantity,
    };
  });

  const identities = out.map((a) => a.allocationRef);
  if (new Set(identities).size !== identities.length) {
    throw fail("VALIDATION", "Each allocation needs its own reference.", { field: "allocations" });
  }
  const pairs = out.map((a) => `${a.lineSplitRef}|${a.dropRef}`);
  if (new Set(pairs).size !== pairs.length) {
    throw fail("VALIDATION",
      "The same split and delivery are allocated twice. State one quantity for each pair.",
      { field: "allocations" });
  }

  const splitSum = (ref) => out.filter((a) => a.lineSplitRef === ref).reduce((t, a) => t + a.quantity, 0);
  const dropSum = (ref) => out.filter((a) => a.dropRef === ref).reduce((t, a) => t + a.quantity, 0);

  /* ── ORPHANS FIRST ────────────────────────────────────────────────────
     A split nobody allocated also makes every other split's arithmetic
     wrong, so checking sums first would report the consequence and leave the
     cause unmentioned. "You have not said when S2 ships" is the sentence
     somebody can act on. */
  for (const b of breakdown) {
    if (splitSum(b.lineSplitRef) === 0) {
      throw fail("VALIDATION", `Split "${b.lineSplitRef}" is confirmed but ships in no delivery.`,
        { field: "allocations", lineSplitRef: b.lineSplitRef });
    }
  }
  for (const d of deliveries) {
    if (dropSum(d.dropRef) === 0) {
      throw fail("VALIDATION", `Delivery "${d.dropRef}" is confirmed but carries no split.`,
        { field: "allocations", dropRef: d.dropRef });
    }
  }

  /* Each axis must still add up to what Sales confirmed on it — the mapping
     redistributes the line, it does not restate it. */
  for (const b of breakdown) {
    const sum = splitSum(b.lineSplitRef);
    if (sum !== b.quantity) {
      throw fail("VALIDATION",
        `Split "${b.lineSplitRef}" is allocated ${sum} against a confirmed ${b.quantity}.`,
        { field: "allocations", lineSplitRef: b.lineSplitRef, sum, confirmed: b.quantity });
    }
  }
  for (const d of deliveries) {
    const sum = dropSum(d.dropRef);
    if (sum !== d.quantity) {
      throw fail("VALIDATION",
        `Delivery "${d.dropRef}" is allocated ${sum} against a confirmed ${d.quantity}.`,
        { field: "allocations", dropRef: d.dropRef, sum, confirmed: d.quantity });
    }
  }

  const total = out.reduce((t, a) => t + a.quantity, 0);
  if (total !== totalQuantity) {
    throw fail("VALIDATION",
      `The allocations total ${total}, and the confirmed line is ${totalQuantity}. They must reconcile exactly.`,
      { field: "allocations", sum: total, totalQuantity });
  }
  return out;
}

/* ═══ THE UNIT PLAN ════════════════════════════════════════════════════════ */

/**
 * The Execution Units one projection produces — the single source of this
 * rule, for the producer that validates it and the receiver that stores it.
 *
 * ── IDENTITY IS BUILT FROM SOURCE REFERENCES, NEVER FROM LABELS ────────────
 *   DEFAULT                        no split of any kind
 *   DROP:<dropRef>                 split only by delivery
 *   SPLIT:<lineSplitRef>           split only by colourway/size
 *   UNIT:<lineSplitRef>|<dropRef>  split by both, per the allocation mapping
 *
 * A colourway renamed from "Navy" to "Midnight Navy" is the same confirmed
 * split, so it must remain the same unit; an identity built from attribute
 * text would silently withdraw the old unit and open a new one, taking every
 * selection attached to it out of the file. The nominated factory is likewise
 * absent: it is a property OF the drop, so `dropRef` already distinguishes
 * two factories, and folding it in would make a corrected factory look like a
 * different unit.
 *
 * Every returned unit carries the references it came from, so a figure on a
 * unit can always be traced to the row of the projection that stated it.
 */
function deriveUnitPlan(projection = {}) {
  const total = int(projection.totalQuantity);
  const breakdown = projection.breakdown || [];
  const deliveries = projection.deliveries || [];
  const allocations = projection.allocations || [];

  const fromDrop = (d = {}) => ({
    dropRef: str(d.dropRef),
    committedDeliveryDate: d.committedDeliveryDate || null,
    nominatedFactoryRef: str(d.nominatedFactoryRef),
  });
  const fromSplit = (b = {}) => ({
    lineSplitRef: str(b.lineSplitRef),
    attributes: (b.attributes || []).map((a) => ({ name: str(a.name), value: str(a.value) })),
    sizeRange: str(b.sizeRange),
  });

  /* Refused here as well as at issue: a projection carrying a mapping it has
     no use for is one whose two readers would disagree about what it means. */
  if (!needsAllocations(breakdown, deliveries) && allocations.length) {
    normaliseAllocations(allocations, breakdown, deliveries, total);
  }

  let units = [];

  if (breakdown.length === 0 && deliveries.length <= 1) {
    /* No split of any kind: the line is one unit. */
    units = [{
      unitDiscriminator: "DEFAULT",
      ...fromSplit(), ...fromDrop(deliveries[0]),
      lineSplitRef: "",
      quantity: total,
    }];
  } else if (breakdown.length === 0) {
    /* Delivery drops only. */
    units = deliveries.map((d) => ({
      unitDiscriminator: `DROP:${str(d.dropRef)}`,
      ...fromSplit(), ...fromDrop(d),
      lineSplitRef: "",
      quantity: int(d.quantity),
    }));
  } else if (deliveries.length <= 1) {
    /* Confirmed splits, one delivery — every split carries that delivery. */
    const d = deliveries[0] || {};
    units = breakdown.map((b) => ({
      unitDiscriminator: `SPLIT:${str(b.lineSplitRef)}`,
      ...fromSplit(b), ...fromDrop(d),
      quantity: int(b.quantity),
    }));
  } else if (breakdown.length === 1) {
    /* One split, several deliveries — every drop carries that split. */
    const b = breakdown[0];
    units = deliveries.map((d) => ({
      unitDiscriminator: `DROP:${str(d.dropRef)}`,
      ...fromSplit(b), ...fromDrop(d),
      quantity: int(d.quantity),
    }));
  } else {
    /* Both axes: the mapping decides, and there must be one. */
    const mapping = normaliseAllocations(allocations, breakdown, deliveries, total);
    const splitByRef = new Map(breakdown.map((b) => [str(b.lineSplitRef), b]));
    const dropByRef = new Map(deliveries.map((d) => [str(d.dropRef), d]));
    units = mapping.map((a) => ({
      unitDiscriminator: `UNIT:${a.lineSplitRef}|${a.dropRef}`,
      ...fromSplit(splitByRef.get(a.lineSplitRef)),
      ...fromDrop(dropByRef.get(a.dropRef)),
      allocationRef: a.allocationRef,
      quantity: a.quantity,
    }));
  }

  /* ── THE WHOLE LINE, COUNTED ONCE ──────────────────────────────────────
     Not "each axis reconciles" — that was the defect. Every unit together
     is the confirmed line, exactly once. */
  const sum = units.reduce((t, u) => t + u.quantity, 0);
  if (sum !== total) {
    throw fail("VALIDATION",
      `The execution units total ${sum} against a confirmed ${total}. The handover does not reconcile.`,
      { sum, total });
  }
  const ids = units.map((u) => u.unitDiscriminator);
  if (new Set(ids).size !== ids.length) {
    throw fail("VALIDATION", "Two execution units would share one identity.", { units: ids });
  }
  return units;
}

module.exports = {
  DELIVERY_FIELDS, BREAKDOWN_FIELDS, ALLOCATION_FIELDS,
  normaliseDeliveries, normaliseBreakdown, normaliseAllocations,
  needsAllocations, deriveUnitPlan,
};

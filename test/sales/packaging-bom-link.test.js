// test/sales/packaging-bom-link.test.js
//
// ONE BOM → PACKAGING WORKFLOW, OVER TWO OWNED RECORDS.
//
// Merchandising selects WHICH components (`materials.packagingSelections`).
// R&D records HOW MUCH (`sample.packagingRequirements`). This proves the join
// between them: that an approved selection appears once and only once, that
// running it again changes nothing, that R&D's figures survive, and that R&D
// cannot quietly swap the component it was asked to measure.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const bom = require("../../services/sales/packagingBom.service");

const SEL = (over = {}) => ({
  rowId: "sel-1", rawItemId: "item-1", rawItemName: "Poly bag", rawItemSku: "PKG-1",
  specification: "Printed poly bag, 300x400mm", status: "approved", ...over,
});
const REQ = (over = {}) => ({
  rowId: "req-1", rawItemId: "item-1", rawItemName: "Poly bag",
  quantity: 1, unit: "Piece", basis: "PER_GARMENT", evidence: "SAMPLE_MEASURED",
  included: true, ...over,
});

/* ═══ 1 · AN APPROVED SELECTION APPEARS ONCE ══════════════════════════════ */

describe("seeding from an approved selection", () => {
  test("it produces exactly one requirement, with no consumption invented", () => {
    const { rows, requirements } = bom.mergePackaging([SEL()], []);
    expect(requirements).toHaveLength(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ selectionStatus: "approved", seeded: true, rawItemName: "Poly bag" });
    /* Identity and the packing instruction come across; how much is R&D's,
       and nothing is guessed on their behalf. */
    expect(requirements[0].specification).toBe("Printed poly bag, 300x400mm");
    expect(requirements[0].sourceSelectionRowId).toBe("sel-1");
    expect(requirements[0].quantity).toBeUndefined();
    expect(requirements[0].unit).toBeUndefined();
  });

  test("running it again changes nothing", () => {
    /* It runs on every read as well as every save. A merge that appended per
       pass would grow a duplicate requirement per page view. */
    const first = bom.mergePackaging([SEL()], []);
    const second = bom.mergePackaging([SEL()], first.requirements);
    const third = bom.mergePackaging([SEL()], second.requirements);
    expect(second.requirements).toHaveLength(1);
    expect(third.requirements).toHaveLength(1);
    expect(third.requirements).toEqual(second.requirements);
  });

  test("two selections naming the SAME item stay two components", () => {
    /* An inner bag and an outer bag. Joining on the item would collapse them
       into one requirement and lose a component. */
    const sels = [SEL({ rowId: "a", specification: "Inner" }), SEL({ rowId: "b", specification: "Outer" })];
    const { requirements } = bom.mergePackaging(sels, []);
    expect(requirements).toHaveLength(2);
    expect(requirements.map((r) => r.sourceSelectionRowId).sort()).toEqual(["a", "b"]);
    /* And a second pass still leaves two. */
    expect(bom.mergePackaging(sels, requirements).requirements).toHaveLength(2);
  });
});

/* ═══ 2 · A PROPOSAL IS NOT YET WORK FOR R&D ══════════════════════════════ */

describe("a proposed selection", () => {
  test("it is shown but seeds nothing", () => {
    const { rows, requirements } = bom.mergePackaging([SEL({ status: "proposed" })], []);
    expect(requirements).toHaveLength(0);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ selectionStatus: "proposed", seeded: false, requirement: null });
  });

  test("approving it later seeds it, once", () => {
    const proposed = bom.mergePackaging([SEL({ status: "proposed" })], []);
    const approved = bom.mergePackaging([SEL()], proposed.requirements);
    expect(approved.requirements).toHaveLength(1);
    expect(bom.mergePackaging([SEL()], approved.requirements).requirements).toHaveLength(1);
  });
});

/* ═══ 3 · WITHDRAWN NEVER DELETES ════════════════════════════════════════ */

describe("a withdrawn selection", () => {
  const withdrawn = SEL({ status: "withdrawn", withdrawnReason: "Customer supplies bags." });

  test("R&D's requirement survives, and the row says what happened", () => {
    /* R&D may have measured it and a costing version may have frozen it. */
    const existing = [REQ({ sourceSelectionRowId: "sel-1", quantity: 2 })];
    const { rows, requirements } = bom.mergePackaging([withdrawn], existing);
    expect(requirements).toHaveLength(1);
    expect(requirements[0].quantity).toBe(2);
    expect(rows[0]).toMatchObject({
      selectionStatus: "withdrawn",
      withdrawnReason: "Customer supplies bags.",
      seeded: true,
    });
    expect(rows[0].requirement.quantity).toBe(2);
  });

  test("it is never silently hidden", () => {
    const { rows } = bom.mergePackaging([withdrawn], []);
    expect(rows).toHaveLength(1);
    expect(rows[0].selectionStatus).toBe("withdrawn");
    expect(rows[0].withdrawnReason).toBe("Customer supplies bags.");
  });
});

/* ═══ 4 · R&D'S FIGURES SURVIVE, AND ITS IDENTITY DOES NOT MOVE ═══════════ */

describe("what a re-merge preserves and what it rebuilds", () => {
  test("every R&D field survives", () => {
    const measured = REQ({
      sourceSelectionRowId: "sel-1", quantity: 3, unit: "Piece", basis: "PER_CARTON",
      evidence: "SAMPLE_MEASURED", included: true, notes: "two liners per carton",
    });
    const { requirements } = bom.mergePackaging([SEL()], [measured]);
    expect(requirements[0]).toMatchObject({
      quantity: 3, unit: "Piece", basis: "PER_CARTON",
      evidence: "SAMPLE_MEASURED", included: true, notes: "two liners per carton",
    });
  });

  test("an exclusion and its reason survive", () => {
    const excluded = REQ({ sourceSelectionRowId: "sel-1", included: false, excludedReason: "Customer supplies bags." });
    const { requirements } = bom.mergePackaging([SEL()], [excluded]);
    expect(requirements[0].included).toBe(false);
    expect(requirements[0].excludedReason).toBe("Customer supplies bags.");
  });

  test("R&D cannot switch to an item nobody approved", () => {
    /* Submitted with a different component. The identity is rebuilt from the
       approved selection, so the swap contributes nothing. */
    const swapped = REQ({ sourceSelectionRowId: "sel-1", rawItemId: "item-999", rawItemName: "Something else", quantity: 5 });
    const { requirements } = bom.mergePackaging([SEL()], [swapped]);
    expect(requirements[0].rawItemId).toBe("item-1");
    expect(requirements[0].rawItemName).toBe("Poly bag");
    /* Their measurement is kept — it is the identity that is not theirs. */
    expect(requirements[0].quantity).toBe(5);
  });

  test("the approved specification is authoritative", () => {
    const rewritten = REQ({ sourceSelectionRowId: "sel-1", specification: "R&D's own words" });
    const { requirements } = bom.mergePackaging([SEL()], [rewritten]);
    expect(requirements[0].specification).toBe("Printed poly bag, 300x400mm");
  });
});

/* ═══ 5 · LEGACY STYLES KEEP WORKING ══════════════════════════════════════ */

describe("a style with requirements and no selections", () => {
  test("the requirement is kept, costable, and labelled — never backfilled", () => {
    const legacy = [REQ({ rowId: "old-1", quantity: 1 })];
    const { rows, requirements } = bom.mergePackaging([], legacy);
    expect(requirements).toHaveLength(1);
    expect(requirements[0].quantity).toBe(1);
    expect(rows[0].selectionStatus).toBe("LEGACY");
    /* No selection was invented for it. */
    expect(requirements[0].sourceSelectionRowId).toBeUndefined();
  });

  test("an unlinked requirement is ADOPTED by a matching approval, once", () => {
    const legacy = [REQ({ rowId: "old-1", quantity: 4 })];
    const first = bom.mergePackaging([SEL()], legacy);
    expect(first.requirements).toHaveLength(1);
    expect(first.requirements[0].quantity).toBe(4);
    expect(first.requirements[0].sourceSelectionRowId).toBe("sel-1");
    expect(first.adopted).toHaveLength(1);

    /* And having gained the link, it is never adopted again. */
    const second = bom.mergePackaging([SEL()], first.requirements);
    expect(second.requirements).toHaveLength(1);
    expect(second.adopted).toHaveLength(0);
  });

  test("a second unlinked row for the same item is not attached to a selection nobody named", () => {
    const two = [REQ({ rowId: "old-1", quantity: 1 }), REQ({ rowId: "old-2", quantity: 9 })];
    const { rows, requirements } = bom.mergePackaging([SEL()], two);
    expect(requirements).toHaveLength(2);
    /* One adopted, one still legacy — not silently merged. */
    expect(rows.filter((r) => r.selectionStatus === "LEGACY")).toHaveLength(1);
  });
});

/* ═══ 6 · THE CARTON CONVERSION STAYS ON THE SHIPMENT ═════════════════════ */

describe("readiness", () => {
  test("a PER_CARTON row blocks without the shipment's carton count", () => {
    const { rows } = bom.mergePackaging([SEL()], [REQ({ sourceSelectionRowId: "sel-1", basis: "PER_CARTON" })]);
    const r = bom.readiness(rows, { garmentsPerCarton: null });
    expect(r.ready).toBe(false);
    const gap = r.gaps.find((g) => g.field === "shipment.garmentsPerCarton");
    expect(gap.owner).toBe("RND");
    expect(gap.message).toMatch(/how many garments a carton holds/i);
    expect(gap.message).toMatch(/freight reads the same number/i);
  });

  test("with the count recorded it is ready", () => {
    const { rows } = bom.mergePackaging([SEL()], [REQ({ sourceSelectionRowId: "sel-1", basis: "PER_CARTON" })]);
    expect(bom.readiness(rows, { garmentsPerCarton: 25 }).ready).toBe(true);
  });

  test("no carton capacity is ever copied onto a packaging row", () => {
    /* One fact for the style, shared with freight. A per-row copy would let
       one style hold two answers. */
    const { requirements } = bom.mergePackaging([SEL()], [REQ({ sourceSelectionRowId: "sel-1", basis: "PER_CARTON", garmentsPerCarton: 25 })]);
    expect(requirements[0].garmentsPerCarton).toBeUndefined();
  });

  test("missing consumption and unit are named against R&D", () => {
    const { rows } = bom.mergePackaging([SEL()], []);
    const r = bom.readiness(rows, { garmentsPerCarton: 25 });
    expect(r.gaps.map((g) => g.field).sort()).toEqual(["quantity", "unit"]);
    expect(r.gaps.every((g) => g.owner === "RND")).toBe(true);
    expect(r.gaps[0].message).toMatch(/Poly bag/);
  });

  test("an excluded row owes nothing", () => {
    const { rows } = bom.mergePackaging([SEL()], [REQ({ sourceSelectionRowId: "sel-1", included: false, excludedReason: "n/a", quantity: undefined, unit: "" })]);
    expect(bom.readiness(rows, {}).ready).toBe(true);
  });
});

/* ═══ 7 · WHAT MAY NEVER TRAVEL ON PACKAGING DATA ═════════════════════════ */

describe("the public shape", () => {
  test("no rate, supplier or carton capacity is ever published", () => {
    const dirty = REQ({
      sourceSelectionRowId: "sel-1",
      unitRate: 250, rateMinor: 250, supplierId: "sup-1", supplierName: "Packer",
      garmentsPerCarton: 25, price: 99,
    });
    const published = bom.publicRequirement(dirty);
    for (const banned of ["unitRate", "rateMinor", "supplierId", "supplierName", "garmentsPerCarton", "price"]) {
      expect(published[banned]).toBeUndefined();
    }
    expect(JSON.stringify(published)).not.toMatch(/rate|supplier|carton|price/i);
  });

  test("only R&D's own fields are treated as theirs", () => {
    expect([...bom.RND_FIELDS].sort()).toEqual(
      ["basis", "evidence", "excludedReason", "included", "notes", "quantity", "unit"],
    );
  });
});

/* ═══ 8 · THE SAFE HANDOFF BACK TO MERCHANDISING ══════════════════════════ */

describe("Merchandising's R&D handoff status", () => {
  test("reports only whether consumption is required or recorded", () => {
    const awaiting = bom.mergePackaging([SEL()], []).rows[0];
    const recorded = bom.mergePackaging([SEL()], [REQ({ sourceSelectionRowId: "sel-1" })]).rows[0];

    expect(bom.merchandisingHandoff(awaiting)).toEqual({
      state: "RND_CONSUMPTION_REQUIRED", label: "R&D consumption still required",
    });
    expect(bom.merchandisingHandoff(recorded)).toEqual({
      state: "RND_CONSUMPTION_RECORDED", label: "R&D consumption recorded",
    });
  });

  test("does not carry R&D evidence, measurements, reasons or shipment facts", () => {
    const row = bom.mergePackaging([SEL()], [REQ({
      sourceSelectionRowId: "sel-1", quantity: 2, unit: "Piece",
      evidence: "SAMPLE_MEASURED", notes: "measured on sample", garmentsPerCarton: 25,
    })]).rows[0];
    const handoff = bom.merchandisingHandoff(row);
    expect(handoff).toEqual({ state: "RND_CONSUMPTION_RECORDED", label: "R&D consumption recorded" });
    expect(JSON.stringify(handoff)).not.toMatch(/quantity|unit|evidence|notes|carton|sample/i);
  });

  test("keeps a withdrawn selection's R&D record acknowledged, not erased", () => {
    const row = bom.mergePackaging(
      [SEL({ status: "withdrawn", withdrawnReason: "Customer supplies bags." })],
      [REQ({ sourceSelectionRowId: "sel-1" })],
    ).rows[0];
    expect(bom.merchandisingHandoff(row)).toEqual({
      state: "WITHDRAWN_WITH_RND_RECORD", label: "Withdrawn — R&D record retained",
    });
  });
});

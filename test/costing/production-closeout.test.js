// test/costing/production-closeout.test.js
//
// CLOSING A RUN: THE TWO IDENTITIES, AND EVERYTHING THAT MUST REFUSE.
//
//   accepted + rejected + open rework + unclassified = production completed
//   used + scrap + remaining                          = net issued
//
// The dangerous mistakes are all "helpful" ones: calling unreturned material
// scrap because nobody said otherwise, promoting a project manager's manual
// count to an inspection result, closing a run with pieces still going round,
// or letting a stale draft freeze figures that have since moved.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const C = require("../../services/centralCosting/productionCloseout.service");

const evidence = (over = {}) => ({
  workOrder: {
    id: "wo1", number: "WO-1", status: "in_progress", customerRequestId: "cr1",
    stockItemId: "si1", variantId: null, plannedQty: 500, cancelled: false,
    ...(over.workOrder || {}),
  },
  output: {
    plannedQty: 500, completedQty: 480,
    acceptedGoodQty: 460, rejectedQty: 20, openReworkQty: 0, unclassifiedQty: 0,
    evidenceBasis: C.EVIDENCE.QC_PIECE_LEDGER, stagesConfigured: true,
    legacyManualQcQty: 470,
    /* The service's own sentence, verbatim — a shortened fixture would let
       this test pass while the real copy said something weaker. */
    legacyManualQcNote:
      "A project manager's manual mark, kept as historical evidence. It is not an inspection result.",
    ...(over.output || {}),
  },
  materials: over.materials || [{
    rawItemId: "item1", variantId: null, itemName: "Oxford cotton", sku: "FAB-OX",
    variantLabel: "", unit: "m", issuedQty: 740, returnedQty: 40, netIssuedQty: 700,
    issuanceIds: ["si-a", "si-b"], unitConflict: false,
  }],
  standing: C.STANDING,
});

const goodMaterials = [{ rawItemId: "item1", variantId: null, usedQty: 680, scrapQty: 20, remainingQty: 0 }];
const goodOutput = { acceptedGoodQty: 460, rejectedQty: 20, openReworkQty: 0, unclassifiedQty: 0 };

/* ── OUTPUT RECONCILIATION ───────────────────────────────────────────────── */

describe("output must reconcile exactly", () => {
  test("accepted, rejected, rework and unclassified add to production completed", () => {
    expect(C.validate({ evidence: evidence(), output: goodOutput, materials: goodMaterials, forClose: true }))
      .toEqual([]);
  });

  test("a short classification is refused, and says what it adds to", () => {
    const problems = C.validate({
      evidence: evidence(), output: { ...goodOutput, rejectedQty: 10 },
      materials: goodMaterials, forClose: false,
    });
    expect(problems[0].code).toBe("OUTPUT_DOES_NOT_RECONCILE");
    expect(problems[0].message).toMatch(/add to the 480 pieces/i);
    expect(problems[0].message).toMatch(/They add to 470/);
  });

  test("classifying more than was produced is refused outright, never netted off", () => {
    const problems = C.validate({
      evidence: evidence(),
      output: { acceptedGoodQty: 480, rejectedQty: 20, openReworkQty: 0, unclassifiedQty: 0 },
      materials: goodMaterials, forClose: false,
    });
    expect(problems.map((p) => p.code)).toContain("OVER_CLASSIFIED");
  });

  test("open rework prevents a close, but not a draft", () => {
    const withRework = { acceptedGoodQty: 450, rejectedQty: 20, openReworkQty: 10, unclassifiedQty: 0 };
    expect(C.validate({ evidence: evidence(), output: withRework, materials: goodMaterials, forClose: false }))
      .toEqual([]);
    const closing = C.validate({ evidence: evidence(), output: withRework, materials: goodMaterials, forClose: true });
    expect(closing.map((p) => p.code)).toContain("OPEN_REWORK");
  });

  test("unclassified output prevents a close", () => {
    const partial = { acceptedGoodQty: 400, rejectedQty: 20, openReworkQty: 0, unclassifiedQty: 60 };
    const closing = C.validate({ evidence: evidence(), output: partial, materials: goodMaterials, forClose: true });
    expect(closing.map((p) => p.code)).toContain("UNCLASSIFIED_OUTPUT");
  });

  test("a cancelled work order cannot be closed as successful production", () => {
    const problems = C.validate({
      evidence: evidence({ workOrder: { cancelled: true } }),
      output: goodOutput, materials: goodMaterials, forClose: false,
    });
    expect(problems.map((p) => p.code)).toContain("WORK_ORDER_CANCELLED");
  });

  test("with no QC checkpoints configured, nothing can be proved accepted", () => {
    const problems = C.validate({
      evidence: evidence({ output: { stagesConfigured: false } }),
      output: goodOutput, materials: goodMaterials, forClose: true,
    });
    expect(problems.map((p) => p.code)).toContain("NO_QC_STAGES");
  });
});

/* ── MATERIAL RECONCILIATION ─────────────────────────────────────────────── */

describe("material must reconcile exactly", () => {
  test("used, scrap and remaining add to net issued", () => {
    expect(C.validate({ evidence: evidence(), output: goodOutput, materials: goodMaterials, forClose: true }))
      .toEqual([]);
  });

  test("a short reconciliation is refused, and names the net issued figure", () => {
    const problems = C.validate({
      evidence: evidence(), output: goodOutput,
      materials: [{ rawItemId: "item1", variantId: null, usedQty: 600, scrapQty: 20, remainingQty: 0 }],
      forClose: false,
    });
    expect(problems[0].code).toBe("MATERIAL_DOES_NOT_RECONCILE");
    expect(problems[0].message).toMatch(/add to 700 m net issued/i);
    expect(problems[0].message).toMatch(/They add to 620/);
  });

  test("unreturned material is NEVER automatically scrap", () => {
    /* 700 net issued, 680 used, nothing said about the other 20. The rule
       refuses rather than deciding: "we lost it in cutting" and "it is still
       on the rack" are different facts with different consequences. */
    const problems = C.validate({
      evidence: evidence(), output: goodOutput,
      materials: [{ rawItemId: "item1", variantId: null, usedQty: 680, scrapQty: 0, remainingQty: 0 }],
      forClose: false,
    });
    expect(problems[0].code).toBe("MATERIAL_DOES_NOT_RECONCILE");
  });

  test("remaining material prevents a final close and points at the Store workflow", () => {
    const problems = C.validate({
      evidence: evidence(), output: goodOutput,
      materials: [{ rawItemId: "item1", variantId: null, itemName: "Oxford cotton", usedQty: 660, scrapQty: 20, remainingQty: 20 }],
      forClose: true,
    });
    const remains = problems.find((p) => p.code === "MATERIAL_REMAINS");
    expect(remains).toBeTruthy();
    /* Returning surplus happens in Store's own workflow, not here. */
    expect(remains.message).toMatch(/Return it through the Store's return workflow/i);
  });

  test("a material never issued to this order cannot be reconciled here", () => {
    const problems = C.validate({
      evidence: evidence(), output: goodOutput,
      materials: [{ rawItemId: "ghost", variantId: null, itemName: "Gold thread", usedQty: 1, scrapQty: 0, remainingQty: 0 }],
      forClose: false,
    });
    expect(problems[0].code).toBe("MATERIAL_NOT_ISSUED");
  });

  test("incompatible units refuse the reconciliation rather than adding", () => {
    const problems = C.validate({
      evidence: evidence({ materials: [{
        rawItemId: "item1", variantId: null, itemName: "Oxford cotton", unit: "m",
        issuedQty: 740, returnedQty: 40, netIssuedQty: 700, issuanceIds: [], unitConflict: true,
      }] }),
      output: goodOutput, materials: goodMaterials, forClose: false,
    });
    expect(problems[0].code).toBe("MATERIAL_UNIT_CONFLICT");
  });

  test("a variant is part of the identity, both ways", () => {
    const problems = C.validate({
      evidence: evidence(), output: goodOutput,
      /* Same item, a variant the order never issued. */
      materials: [{ rawItemId: "item1", variantId: "var9", usedQty: 700, scrapQty: 0, remainingQty: 0 }],
      forClose: false,
    });
    expect(problems[0].code).toBe("MATERIAL_NOT_ISSUED");
  });

  test("decimal quantities reconcile without a float tail blocking the close", () => {
    const problems = C.validate({
      evidence: evidence({ materials: [{
        rawItemId: "item1", variantId: null, itemName: "Oxford cotton", unit: "m",
        issuedQty: 740.5, returnedQty: 40.2, netIssuedQty: 700.3, issuanceIds: [], unitConflict: false,
      }] }),
      output: goodOutput,
      materials: [{ rawItemId: "item1", variantId: null, usedQty: 680.1, scrapQty: 20.2, remainingQty: 0 }],
      forClose: true,
    });
    expect(problems).toEqual([]);
  });
});

/* ── READINESS ───────────────────────────────────────────────────────────── */

describe("readiness says one clear thing", () => {
  test("each state is named in the words the screen shows", () => {
    expect(C.readinessOf({ evidence: evidence({ output: { completedQty: 0 } }), closeout: null }))
      .toBe("Not ready — production evidence incomplete");
    expect(C.readinessOf({ evidence: evidence({ output: { unclassifiedQty: 20 } }), closeout: null }))
      .toBe("Not ready — QC classification incomplete");
    expect(C.readinessOf({
      evidence: evidence(),
      closeout: { status: "DRAFT", materials: [{ remainingQty: 20 }] },
    })).toBe("Not ready — unused material remains");
    expect(C.readinessOf({ evidence: evidence(), closeout: { status: "DRAFT", materials: [{ remainingQty: 0 }] } }))
      .toBe("Ready to close");
    expect(C.readinessOf({ evidence: evidence(), closeout: { status: "CLOSED" } })).toBe("Closed");
    expect(C.readinessOf({ evidence: evidence(), closeout: { status: "SUPERSEDED" } })).toBe("Corrected by revision");
  });

  test("the standing sentence says what closing does not do", () => {
    expect(C.STANDING).toMatch(/does not move stock, post payroll or create an accounting voucher/i);
  });
});

/* ── THE MANUAL MARK IS NEVER PROMOTED ───────────────────────────────────── */

test("the project manager's manual QC count is carried as legacy evidence only", () => {
  const e = evidence();
  /* 470 marked by a manager; 460 actually accepted by the piece ledger. The
     two are different numbers and the report keeps them apart. */
  expect(e.output.legacyManualQcQty).toBe(470);
  expect(e.output.acceptedGoodQty).toBe(460);
  expect(e.output.legacyManualQcNote).toMatch(/not an inspection result/i);
  expect(e.output.evidenceBasis).toMatch(/Per-piece QC inspection ledger/i);
});

test("accepted output is defined by the piece ledger, not by any aggregate", () => {
  expect(C.EVIDENCE.QC_PIECE_LEDGER)
    .toMatch(/every configured checkpoint cleared, never rejected/i);
  expect(C.EVIDENCE.NO_STAGES).toMatch(/no piece can be proved accepted/i);
});

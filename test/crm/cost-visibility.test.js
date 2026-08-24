// test/crm/cost-visibility.test.js — who may see what of a costing.
//
// Pure-function tests, deliberately: the enquiries route cannot be required in
// this environment (it lazily pulls in firebaseAdmin, which throws without
// FIREBASE_SERVICE_ACCOUNT), so rules that only lived inside it were rules
// nothing could check. They live in services/crmCostVisibility.js now.
"use strict";

const {
  canSeeCost,
  costingTier,
  visibleParts,
  reduceCostLedger,
} = require("../../services/crmCostVisibility");
const { costingTotals } = require("../../services/costingTotals");

const SALES_REP = { role: "sales", id: "u1" };
const SALES_MANAGER = { role: "sales", departmentRole: "approver", id: "u2" };
const MERCH = { role: "merchandiser", id: "u3" };
const CEO = { role: "ceo", id: "u4" };
// An org admin browsing INTO Sales: `role` is overwritten to Sales' literal,
// only `isAdmin` survives. This is the case a role-only check gets wrong.
const ADMIN_IN_SALES = { role: "sales", isAdmin: true, id: "u5" };

describe("who may see cost", () => {
  test("nobody in Sales — not the rep, not the manager", () => {
    expect(canSeeCost(SALES_REP)).toBe(false);
    expect(canSeeCost(SALES_MANAGER)).toBe(false);
  });

  test("not a merchandiser either — they see their sheet, not the deal's cost", () => {
    expect(canSeeCost(MERCH)).toBe(false);
  });

  test("CEO and admin do", () => {
    expect(canSeeCost(CEO)).toBe(true);
    expect(canSeeCost(ADMIN_IN_SALES)).toBe(true);
  });

  test("an unknown or absent caller does not", () => {
    expect(canSeeCost(null)).toBe(false);
    expect(canSeeCost({})).toBe(false);
    expect(canSeeCost({ role: "project_manager" })).toBe(false);
  });
});

describe("costing tier", () => {
  test("holding a sheet role beats everything — that is how a merchandiser gets rows", () => {
    expect(costingTier(MERCH, "owner")).toBe("sheet");
    expect(costingTier(MERCH, "editor")).toBe("sheet");
    expect(costingTier(SALES_REP, "editor")).toBe("sheet");
  });

  test("Sales with no sheet role gets the floor, manager included", () => {
    expect(costingTier(SALES_REP, null)).toBe("floor");
    expect(costingTier(SALES_MANAGER, null)).toBe("floor");
  });

  test("CEO and admin get cost", () => {
    expect(costingTier(CEO, null)).toBe("cost");
    expect(costingTier(ADMIN_IN_SALES, null)).toBe("cost");
  });

  test("a viewer role on a sheet is not an editing role, so it does not open the rows", () => {
    expect(costingTier(SALES_REP, "viewer")).toBe("floor");
  });
});

describe("each discipline sees its own part", () => {
  const raw = { part: "raw", assignee: { employeeId: "GR0067" }, members: [{ employeeId: "GR0067", role: "owner" }] };
  const ops = { part: "operations", assignee: { employeeId: "GR0099" }, members: [{ employeeId: "GR0099", role: "owner" }] };
  const parts = [raw, ops];

  test("the merchandiser gets raw materials and not operations", () => {
    expect(visibleParts(parts, { coworkEmployeeId: "GR0067" })).toEqual([raw]);
  });

  test("the industrial engineer gets operations and not raw materials", () => {
    expect(visibleParts(parts, { coworkEmployeeId: "GR0099" })).toEqual([ops]);
  });

  test("membership counts, not just assignment", () => {
    const shared = { part: "operations", members: [{ employeeId: "GR0067", role: "editor" }] };
    expect(visibleParts([shared], { coworkEmployeeId: "GR0067" })).toEqual([shared]);
  });

  test("someone with no part on this product sees no rows at all", () => {
    expect(visibleParts(parts, { coworkEmployeeId: "GR0001" })).toEqual([]);
    expect(visibleParts(parts, null)).toEqual([]);
  });

  test("a caller who may see everything gets everything", () => {
    expect(visibleParts(parts, null, true)).toEqual(parts);
  });

  test("a combined sheet is one document and is not split back into halves", () => {
    const combined = { part: "combined", members: [{ employeeId: "GR0067" }] };
    expect(visibleParts([combined], { coworkEmployeeId: "GR0067" })).toEqual([combined]);
  });
});

describe("the cost ledger, reduced", () => {
  const ledger = [
    { productName: "Scrub top", cost: 412, price: 468 },
    { productName: "Ward coat", cost: 690 },
    { productName: "Scrub cap", price: 0 },
  ];

  test("a cost-authorised caller gets it untouched", () => {
    expect(reduceCostLedger(ledger, true, 22)).toBe(ledger);
  });

  test("everyone else loses cost and gains the floor price", () => {
    const out = reduceCostLedger(ledger, false, 22);
    expect(out[0]).toEqual({ productName: "Scrub top", price: 468, costed: true, floorPrice: 502.64 });
    expect(out[1]).toEqual({ productName: "Ward coat", costed: true, floorPrice: 841.8 });
  });

  test("cost is ABSENT, not null — a null would claim the product has no cost", () => {
    const out = reduceCostLedger(ledger, false, 22);
    expect("cost" in out[0]).toBe(false);
  });

  test("an uncosted line says so, and has no floor to quote against", () => {
    const out = reduceCostLedger(ledger, false, 22);
    expect(out[2]).toEqual({ productName: "Scrub cap", price: 0, costed: false, floorPrice: null });
  });

  test("the price the salesperson set survives — it is theirs to see", () => {
    expect(reduceCostLedger(ledger, false, 22)[0].price).toBe(468);
  });
});

describe("the floor is a markup, not a margin", () => {
  const parts = [{ materials: [{ unitCost: 412, consumption: 1 }] }];

  test("cost + 22%, not the price that yields 22% margin", () => {
    const t = costingTotals(parts, 22);
    expect(t.floorPrice).toBe(502.64);          // 412 × 1.22
    expect(t.floorPrice).not.toBeCloseTo(528.21, 1); // 412 ÷ 0.78, the old rule
  });

  test("and the margin it actually realises is lower than the number itself", () => {
    const t = costingTotals(parts, 22);
    const realised = ((t.floorPrice - 412) / t.floorPrice) * 100;
    expect(realised).toBeCloseTo(18.0, 1);
  });

  test("the percentage is reported back as a markup", () => {
    expect(costingTotals(parts, 22).markupPercent).toBe(22);
  });

  test("a markup above 100 is allowed — unlike a margin, it is a real policy", () => {
    expect(costingTotals(parts, 150).floorPrice).toBe(1030);
  });

  test("an uncosted product has no floor rather than a floor of zero", () => {
    expect(costingTotals([], 22).floorPrice).toBeNull();
  });
});

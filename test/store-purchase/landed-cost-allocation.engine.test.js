// test/store-purchase/landed-cost-allocation.engine.test.js
//
// Landed-cost V2 — the pure allocation math. Receipt-base-value basis, paise
// deterministic, remainder on the last positive-base target, exact footing.
"use strict";

const {
  allocateByBaseValue,
  classifyChargeHint,
  ALLOCATION_BASES,
  REFUSAL,
} = require("../../services/landedCostAllocation.service");

describe("allocation by receipt base value", () => {
  // 1
  test("₹300 across base values ₹1,000 and ₹2,000 becomes ₹100 and ₹200", () => {
    const r = allocateByBaseValue({
      totalCharge: 300,
      targets: [
        { key: "a", baseValue: 1000, receivedQuantity: 10 },
        { key: "b", baseValue: 2000, receivedQuantity: 10 },
      ],
    });
    expect(r.ok).toBe(true);
    const a = r.allocations.find((x) => x.key === "a");
    const b = r.allocations.find((x) => x.key === "b");
    expect(a.allocatedAmount).toBe(100);
    expect(b.allocatedAmount).toBe(200);
    expect(a.allocatedPerUnit).toBe(10); // 100 / 10 received
  });

  // 2
  test("paise rounding sums EXACTLY to the entered charge", () => {
    const r = allocateByBaseValue({
      totalCharge: 100,
      targets: [
        { key: "a", baseValue: 1, receivedQuantity: 1 },
        { key: "b", baseValue: 1, receivedQuantity: 1 },
        { key: "c", baseValue: 1, receivedQuantity: 1 },
      ],
    });
    const sum = r.allocations.reduce((s, x) => s + x.allocatedAmount, 0);
    expect(Math.round(sum * 100) / 100).toBe(100); // exact
    // remainder lands on the last deterministic target
    expect(r.allocations.map((x) => x.allocatedAmount)).toEqual([33.33, 33.33, 33.34]);
  });

  // 3
  test("ordered-but-unreceived targets (zero base) receive nothing", () => {
    const r = allocateByBaseValue({
      totalCharge: 150,
      targets: [
        { key: "recv", baseValue: 1500, receivedQuantity: 15 },
        { key: "unreceived", baseValue: 0, receivedQuantity: 0 }, // ordered, not received
      ],
    });
    expect(r.ok).toBe(true);
    expect(r.allocations.find((x) => x.key === "recv").allocatedAmount).toBe(150);
    expect(r.allocations.find((x) => x.key === "unreceived").allocatedAmount).toBe(0);
  });

  // 5
  test("a zero / missing total base value is refused, not divided equally", () => {
    const r = allocateByBaseValue({
      totalCharge: 100,
      targets: [
        { key: "a", baseValue: 0, receivedQuantity: 5 },
        { key: "b", baseValue: null, receivedQuantity: 5 },
      ],
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe(REFUSAL.ZERO_TOTAL_BASE);
  });

  test("a non-positive or non-finite charge is refused", () => {
    expect(allocateByBaseValue({ totalCharge: 0, targets: [{ key: "a", baseValue: 10 }] }).reason).toBe(REFUSAL.INVALID_CHARGE);
    expect(allocateByBaseValue({ totalCharge: -5, targets: [{ key: "a", baseValue: 10 }] }).reason).toBe(REFUSAL.INVALID_CHARGE);
    expect(allocateByBaseValue({ totalCharge: Number.NaN, targets: [{ key: "a", baseValue: 10 }] }).reason).toBe(REFUSAL.INVALID_CHARGE);
  });

  // 4 (basis honesty) — weight/volume are declared unavailable, never faked
  test("only receipt_base_value is available; weight/volume are unavailable", () => {
    const supported = ALLOCATION_BASES.filter((b) => b.available).map((b) => b.value);
    expect(supported).toEqual(["receipt_base_value"]);
    const r = allocateByBaseValue({ totalCharge: 100, basis: "weight", targets: [{ key: "a", baseValue: 10, receivedQuantity: 1 }] });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe(REFUSAL.UNSUPPORTED_BASIS);
  });

  test("a larger multi-line split still foots exactly with remainder on the last", () => {
    const r = allocateByBaseValue({
      totalCharge: 1000,
      targets: [
        { key: "a", baseValue: 333, receivedQuantity: 3 },
        { key: "b", baseValue: 333, receivedQuantity: 3 },
        { key: "c", baseValue: 334, receivedQuantity: 3 },
      ],
    });
    const sum = r.allocations.reduce((s, x) => s + x.allocatedAmount, 0);
    expect(Math.round(sum * 100) / 100).toBe(1000);
  });
});

describe("charge classification hints (never auto-select)", () => {
  // 9 (hint half) — recoverable GST is flagged excluded, never auto-included
  test("recoverable GST and other excluded categories are hinted 'excluded'", () => {
    expect(classifyChargeHint("IGST Input Credit")).toBe("excluded");
    expect(classifyChargeHint("CGST")).toBe("excluded");
    expect(classifyChargeHint("Bank payment charges")).toBe("excluded");
    expect(classifyChargeHint("Late payment penalty")).toBe("excluded");
  });

  test("acquisition costs are hinted 'eligible'", () => {
    expect(classifyChargeHint("Inward freight")).toBe("eligible");
    expect(classifyChargeHint("Transit insurance")).toBe("eligible");
    expect(classifyChargeHint("Customs duty")).toBe("eligible");
    expect(classifyChargeHint("Clearing and handling")).toBe("eligible");
  });

  test("an unrecognised charge is 'unknown' — Accounting decides explicitly", () => {
    expect(classifyChargeHint("Misc adjustment")).toBe("unknown");
  });
});

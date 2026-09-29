// test/costing/labour-mapping-and-duplicates.test.js
//
// AN OPERATION'S RATE IS DERIVED, NEVER TYPED — AND A DUPLICATE CODE IS
// REFUSED RATHER THAN GUESSED.
//
// ── WHAT THIS PINS ──────────────────────────────────────────────────────────
// The costing engine turns a SAM into rupees from three sources it does not
// own: the salary group on the registered operation, that group's live
// payroll, and the company's costing policy. This proves the chain end to end,
// and proves the two ways it is allowed to refuse: an operation nobody mapped,
// and a code that names more than one registered operation.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const Operation = require("../../models/CMS_Models/Inventory/Configurations/Operation");
const Employee = require("../../models/Employee");
const { costOperations, avgSalaryFor } = require("../../services/operationCosting");
const labourCost = require("../../services/centralCosting/labourCost");
const { encryptSalaryFields } = require("../../utils/salaryEncryption");

let seq = 0;

/**
 * Employees in a department/designation, each on a known net salary.
 *
 * Inserted straight into the collection: `Employee`'s pre-save hook recomputes
 * the whole salary breakdown from `gross` through the payroll formula, which
 * would overwrite the exact net figure this test is checking the LOOKUP reads.
 * The payroll formula has its own tests; this one is about what
 * `avgSalaryFor` does with a stored salary.
 */
async function payroll({ department, designation, netSalary, count = 2 }) {
  const n = ++seq;
  const docs = [];
  for (let i = 0; i < count; i += 1) {
    docs.push({
      firstName: "P", lastName: `${n}-${i}`, email: `pay-${n}-${i}@test.com`,
      biometricId: `PY${n}${i}`, isActive: true, gender: "Other",
      department, designation,
      salary: encryptSalaryFields({ netSalary: Number(netSalary) }),
    });
  }
  await Employee.collection.insertMany(docs);
}

/* ═══ 1 · THE POLICY ARITHMETIC ═══════════════════════════════════════════ */

describe("what the company policy turns a SAM into", () => {
  const POLICY = { employerBurdenPercent: "20", productiveMinutesPerMonth: 10000, machineBurdenTreatment: "IN_OVERHEAD" };

  test("employer cost / productive minutes x SAM, rounded once", () => {
    const r = labourCost.labourCostPerGarment({
      samMinutes: "0.56", netSalaryPerMonth: 20000, policy: POLICY,
    });
    expect(r.ok).toBe(true);
    /* 20,000 x 1.20 = 24,000 employer cost
       24,000 / 10,000 = 2.40 per productive minute
       2.40 x 0.56 SAM = ₹1.344 -> 134 paise */
    expect(r.amountMinor).toBe(134);
    expect(r.workings).toMatchObject({
      employerCostPerMonth: "24000.00",
      productiveMinutesPerMonth: "10000.00",
      costPerMinute: "2.400000",
      productiveBasis: "STATED_MINUTES",
    });
  });

  test("an efficiency basis derives the minutes from the paid month", () => {
    const r = labourCost.labourCostPerGarment({
      samMinutes: "1", netSalaryPerMonth: 12480,
      policy: { employerBurdenPercent: "0", labourEfficiencyPercent: "50" },
    });
    /* 50% of 12,480 paid minutes = 6,240 productive.
       12,480 / 6,240 = ₹2.00 a minute. */
    expect(r.amountMinor).toBe(200);
    expect(r.workings.productiveBasis).toBe("EFFICIENCY");
    expect(r.workings.productiveBasisLabel).toMatch(/50% of 12,480 paid minutes/);
  });

  test("stating BOTH bases is refused rather than silently preferred", () => {
    const r = labourCost.labourCostPerGarment({
      samMinutes: "1", netSalaryPerMonth: 20000,
      policy: { employerBurdenPercent: "10", productiveMinutesPerMonth: 9000, labourEfficiencyPercent: "80" },
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("PRODUCTIVE_BASIS_AMBIGUOUS");
  });

  test("an unset assumption blocks rather than costing at zero", () => {
    for (const policy of [
      { employerBurdenPercent: "20" },                       // no productive basis
      { productiveMinutesPerMonth: 10000 },                  // no employer burden
    ]) {
      const r = labourCost.labourCostPerGarment({ samMinutes: "1", netSalaryPerMonth: 20000, policy });
      expect(r.ok).toBe(false);
      expect(r.amountMinor).toBeUndefined();
    }
  });

  test("machine cost inside the operation rate is refused — there is no source", () => {
    const gaps = labourCost.assumptionGaps({ ...POLICY, machineBurdenTreatment: "IN_OPERATION_RATE" });
    const machine = gaps.find((g) => g.reason === "MACHINE_COST_SOURCE_MISSING");
    expect(machine).toBeTruthy();
    expect(machine.message).toMatch(/no machine-cost source exists/i);
  });
});

/* ═══ 2 · THE MAPPING IS WHAT MAKES A RATE POSSIBLE ═══════════════════════ */

describe("mapping an operation to a salary group", () => {
  test("a mapped operation resolves a salary from live payroll", async () => {
    const n = ++seq;
    const dept = `Tailoring-${n}`;
    await payroll({ department: dept, designation: "Operator", netSalary: 20000 });
    const op = await Operation.create({
      name: `Shoulder join ${n}`, operationCode: `MAP-${n}`, totalSam: 0.56, durationSeconds: 34,
      machineType: "4TH O/L", salaryDept: dept, salaryDesig: "Operator",
    });

    const [row] = await costOperations([{ type: op.name, operationCode: op.operationCode, minutes: 0, seconds: 34 }]);
    expect(row.salaryDept).toBe(dept);
    expect(row.salaryDesig).toBe("Operator");
    expect(row.operatorSalary).toBe(20000);
    /* And the identity is stamped, so a later read never matches on a code. */
    expect(String(row.operationId)).toBe(String(op._id));
  });

  test("an UNMAPPED operation resolves no salary and is not costed at zero", async () => {
    const n = ++seq;
    const op = await Operation.create({
      name: `Unmapped ${n}`, operationCode: `UNM-${n}`, totalSam: 1, durationSeconds: 60, machineType: "SNLS",
    });
    const [row] = await costOperations([{ type: op.name, operationCode: op.operationCode, minutes: 1, seconds: 0 }]);
    expect(row.salaryDept).toBe("");
    expect(row.operatorSalary).toBe(0);

    /* And the labour engine refuses it by name rather than producing 0. */
    const r = labourCost.labourCostPerGarment({
      samMinutes: 1, netSalaryPerMonth: row.operatorSalary,
      policy: { employerBurdenPercent: "20", productiveMinutesPerMonth: 10000 },
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("SALARY_BASIS_UNRESOLVED");
  });

  test("a group with no active employees averages to nothing, not to a guess", async () => {
    expect(await avgSalaryFor(`Ghost-${++seq}`, "Nobody")).toBe(0);
  });
});

/* ═══ 3 · A DUPLICATE CODE IS NEVER RESOLVED ARBITRARILY ══════════════════ */

describe("duplicate operation codes", () => {
  test("a code naming two records resolves to NEITHER, and says which code", async () => {
    const n = ++seq;
    const code = `DUP-${n}`;
    const deptA = `A-${n}`; const deptB = `B-${n}`;
    await payroll({ department: deptA, designation: "Operator", netSalary: 20000 });
    await payroll({ department: deptB, designation: "Operator", netSalary: 90000 });
    /* Two real records under one code, naming DIFFERENT salary groups — the
       case where an arbitrary pick changes the money by 4.5x. */
    await Operation.create([
      { name: `Dup one ${n}`, operationCode: code, totalSam: 1, durationSeconds: 60, machineType: "SNLS", salaryDept: deptA, salaryDesig: "Operator" },
      { name: `Dup two ${n}`, operationCode: code, totalSam: 1, durationSeconds: 60, machineType: "SNLS", salaryDept: deptB, salaryDesig: "Operator" },
    ]);

    const [row] = await costOperations([{ type: "Something else", operationCode: code, minutes: 1, seconds: 0 }]);
    /* No salary was taken from either. */
    expect(row.operatorSalary).toBe(0);
    expect(row.salaryDept).toBe("");
    /* And the code is named, so the refusal is actionable. */
    expect(row.ambiguousOperationCode).toBe(code);
  });

  test("neither record is deleted or merged", async () => {
    const n = ++seq;
    const code = `KEEP-${n}`;
    await Operation.create([
      { name: `Keep one ${n}`, operationCode: code, totalSam: 1, durationSeconds: 60, machineType: "SNLS" },
      { name: `Keep two ${n}`, operationCode: code, totalSam: 1, durationSeconds: 60, machineType: "SNLS" },
    ]);
    await costOperations([{ type: "x", operationCode: code, minutes: 1, seconds: 0 }]);
    expect(await Operation.countDocuments({ operationCode: code })).toBe(2);
  });

  test("STABLE IDENTITY beats an ambiguous code", async () => {
    /* A row that already knows which record it is cannot be confused by a
       duplicate — which is why the id is stamped on first resolution. */
    const n = ++seq;
    const code = `IDW-${n}`;
    const dept = `Id-${n}`;
    await payroll({ department: dept, designation: "Operator", netSalary: 30000 });
    const [chosen] = await Operation.create([
      { name: `Id one ${n}`, operationCode: code, totalSam: 1, durationSeconds: 60, machineType: "SNLS", salaryDept: dept, salaryDesig: "Operator" },
      { name: `Id two ${n}`, operationCode: code, totalSam: 1, durationSeconds: 60, machineType: "SNLS" },
    ]);

    const [row] = await costOperations([
      { type: "x", operationCode: code, operationId: chosen._id, minutes: 1, seconds: 0 },
    ]);
    expect(row.ambiguousOperationCode).toBe("");
    expect(row.salaryDept).toBe(dept);
    expect(row.operatorSalary).toBe(30000);
  });

  test("a reconciled duplicate stops blocking — the marker is cleared, not left", async () => {
    /* `...op` carries the previous run's fields forward, so a marker that was
       only ever SET would survive the fix and keep an operation blocked after
       the manager had already reconciled it. */
    const n = ++seq;
    const dept = `Fixed-${n}`;
    await payroll({ department: dept, designation: "Operator", netSalary: 25000 });
    await Operation.create({
      name: `Fixed ${n}`, operationCode: `FIX-${n}`, totalSam: 1, durationSeconds: 60,
      machineType: "SNLS", salaryDept: dept, salaryDesig: "Operator",
    });
    const [row] = await costOperations([{
      type: "x", operationCode: `FIX-${n}`, minutes: 1, seconds: 0,
      /* Stamped by an earlier run, when the code was still duplicated. */
      ambiguousOperationCode: `FIX-${n}`,
    }]);
    expect(row.ambiguousOperationCode).toBe("");
    expect(row.operatorSalary).toBe(25000);
  });

  test("an unambiguous code still resolves normally", async () => {
    const n = ++seq;
    const dept = `Solo-${n}`;
    await payroll({ department: dept, designation: "Operator", netSalary: 15000 });
    await Operation.create({
      name: `Solo ${n}`, operationCode: `SOLO-${n}`, totalSam: 1, durationSeconds: 60,
      machineType: "SNLS", salaryDept: dept, salaryDesig: "Operator",
    });
    const [row] = await costOperations([{ type: "x", operationCode: `SOLO-${n}`, minutes: 1, seconds: 0 }]);
    expect(row.ambiguousOperationCode).toBe("");
    expect(row.operatorSalary).toBe(15000);
  });

  test("a unique exact code wins when another operation shares only its name", async () => {
    const n = ++seq;
    const dept = `Exact-${n}`;
    await payroll({ department: dept, designation: "Operator", netSalary: 22000 });
    await Operation.create([
      { name: `Shared name ${n}`, operationCode: `EXACT-${n}`, totalSam: 1, durationSeconds: 60, machineType: "SNLS", salaryDept: dept, salaryDesig: "Operator" },
      { name: `Shared name ${n}`, operationCode: `OTHER-${n}`, totalSam: 1, durationSeconds: 60, machineType: "SNLS" },
    ]);

    const [row] = await costOperations([{
      type: `Shared name ${n}`, operationCode: `EXACT-${n}`, minutes: 1, seconds: 0,
    }]);
    expect(row.ambiguousOperationCode).toBe("");
    expect(row.salaryDept).toBe(dept);
    expect(row.operatorSalary).toBe(22000);
  });
});

/* ═══ 4 · A POLICY CHANGE DOES NOT REWRITE HISTORY ════════════════════════ */

describe("policy changes and frozen versions", () => {
  test("the same operation costs differently under a changed policy", () => {
    const args = { samMinutes: "1", netSalaryPerMonth: 20000 };
    const before = labourCost.labourCostPerGarment({
      ...args, policy: { employerBurdenPercent: "20", productiveMinutesPerMonth: 10000 },
    });
    const after = labourCost.labourCostPerGarment({
      ...args, policy: { employerBurdenPercent: "30", productiveMinutesPerMonth: 10000 },
    });
    expect(before.amountMinor).toBe(240);
    expect(after.amountMinor).toBe(260);

    /* ── AND THE EARLIER FIGURE IS UNTOUCHED ──────────────────────────
       The function is pure: it reads the policy handed to it and holds no
       state, so a version that froze `before` keeps 240 whatever the policy
       becomes. The freezing itself is the version's job — what matters here
       is that recalculating cannot reach back. */
    expect(before.amountMinor).toBe(240);
    expect(before.workings.employerBurdenPercent).toBe("20");
    expect(after.workings.employerBurdenPercent).toBe("30");
  });

  test("the workings record everything needed to check the number later", () => {
    const r = labourCost.labourCostPerGarment({
      samMinutes: "0.56", netSalaryPerMonth: 20000,
      policy: { employerBurdenPercent: "20", productiveMinutesPerMonth: 10000, machineBurdenTreatment: "IN_OVERHEAD" },
    });
    /* A frozen version has to be explicable without re-running anything. */
    for (const key of [
      "samMinutes", "netSalaryPerMonth", "employerBurdenPercent", "employerCostPerMonth",
      "productiveMinutesPerMonth", "productiveBasis", "productiveBasisLabel",
      "costPerMinute", "machineBurdenTreatment",
    ]) {
      expect(r.workings[key]).toBeDefined();
    }
    expect(r.workings.machineBurdenTreatment).toBe("IN_OVERHEAD");
  });
});

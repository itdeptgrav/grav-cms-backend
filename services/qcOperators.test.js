// services/qcOperators.test.js — the pure half of services/qcOperators.js.
const test = require("node:test");
const assert = require("node:assert/strict");
const { attributeDefects, scansAtOperation, buildOperatorDefectReport } = require("./qcOperators");

const scan = (operatorId, operatorName, activeOps, scanTime, machineName = "SNLS1") => ({ operatorId, operatorName, activeOps, scanTime: new Date(scanTime), machineName });

test("scansAtOperation matches the operation code case-insensitively and never on an empty snapshot", () => {
  const scans = [scan("GR1", "A", ["p023", "P024"], "2026-09-24T04:00:00Z"), scan("GR2", "B", [], "2026-09-24T05:00:00Z")];
  assert.equal(scansAtOperation(scans, "P023").length, 1);
  assert.equal(scansAtOperation(scans, "P023")[0].operatorId, "GR1");
  assert.equal(scansAtOperation(scans, "P099").length, 0);
  assert.equal(scansAtOperation(scans, "").length, 0);
});

test("attributeDefects names each operator once, at their first scan of that operation, and marks the rest unattributed", () => {
  const scans = [
    scan("GR1", "Asha", ["P023"], "2026-09-24T06:00:00Z"),
    scan("GR1", "Asha", ["P023"], "2026-09-24T04:00:00Z"),
    scan("GR2", "Bala", ["P023"], "2026-09-24T05:00:00Z"),
    scan("GR3", "Chitra", ["P030"], "2026-09-24T07:00:00Z"),
  ];
  const out = attributeDefects([
    { operationCode: "P023", operationName: "Belt", types: [{ code: "PUCK", name: "Puckering" }] },
    { operationCode: "P099", operationName: "Hem", types: [] },
  ], scans);
  assert.equal(out[0].attributed, true);
  assert.deepEqual(out[0].operators.map((o) => [o.operatorId, o.scanTime.toISOString()]),
    [["GR1", "2026-09-24T04:00:00.000Z"], ["GR2", "2026-09-24T05:00:00.000Z"]]);
  assert.equal(out[1].attributed, false);
  assert.equal(out[1].operators.length, 0);
});

test("buildOperatorDefectReport: totals agree across operators, products, operations and the unattributed bucket", () => {
  const scansByBarcode = new Map([
    ["WO-aaaa-001", [scan("GR1", "Asha", ["P023"], "2026-09-24T04:00:00Z"), scan("GR2", "Bala", ["P030"], "2026-09-24T05:00:00Z")]],
    ["WO-aaaa-002", [scan("GR1", "Asha", ["P023", "P030"], "2026-09-24T04:30:00Z")]],
    ["WO-bbbb-001", [scan("GR9", "Zed", [], "2026-09-24T06:00:00Z")]],
  ]);
  const inspections = [
    { barcodeId: "WO-aaaa-001", status: "defective", workOrderId: "w1", inspectedAt: new Date("2026-09-24T08:00:00Z"), inspectedByQCName: "QC1",
      defects: [{ operationCode: "P023", operationName: "Belt", types: [{ code: "PUCK", name: "Puckering" }] }, { operationCode: "P030", operationName: "Hem", types: [] }] },
    { barcodeId: "WO-aaaa-002", status: "rejected", workOrderId: "w1", inspectedAt: new Date("2026-09-24T08:10:00Z"), inspectedByQCName: "QC1",
      defects: [{ operationCode: "P023", operationName: "Belt", types: [{ code: "OTHER", name: "Other", note: "torn belt loop" }] }] },
    { barcodeId: "WO-bbbb-001", status: "defective", workOrderId: "w2", inspectedAt: new Date("2026-09-24T09:00:00Z"), inspectedByQCName: "QC2",
      defects: [{ operationCode: "S001", operationName: "Collar", types: [{ code: "SKIP", name: "Skip stitch" }] }] },
    { barcodeId: "WO-aaaa-003", status: "passed", workOrderId: "w1", inspectedAt: new Date(), defects: [] },
  ];
  const workOrderById = new Map([["w1", { workOrderNumber: "WO-aaaa", stockItemName: "Trouser" }], ["w2", { workOrderNumber: "WO-bbbb", stockItemName: "Shirt" }]]);
  const r = buildOperatorDefectReport({ inspections, scansByBarcode, workOrderById });

  assert.deepEqual(r.summary, { defectivePieces: 3, defectOps: 4, attributedOps: 3, unattributedOps: 1, operators: 2 });
  const asha = r.operators.find((o) => o.operatorId === "GR1");
  const bala = r.operators.find((o) => o.operatorId === "GR2");
  assert.equal(asha.defects, 2); assert.equal(asha.pieces, 2);
  assert.equal(bala.defects, 1);
  // Products under an operator sum to the operator's defects; operations sum to the product's.
  for (const o of r.operators) {
    assert.equal(o.products.reduce((n, p) => n + p.defects, 0), o.defects);
    for (const p of o.products) assert.equal(p.operations.reduce((n, x) => n + x.defects, 0), p.defects);
  }
  const belt = asha.products[0].operations.find((o) => o.operationCode === "P023");
  assert.deepEqual(belt.types.map((t) => [t.name, t.count]), [["Puckering", 1], ["torn belt loop", 1]]);
  assert.equal(belt.pieces[0].scanTime.toISOString(), "2026-09-24T04:00:00.000Z");
  // The shirt's collar defect: nobody scanned S001, so it is unattributed — and still says who scanned the piece.
  assert.equal(r.unattributed.defects, 1);
  const collar = r.unattributed.products[0].operations[0];
  assert.equal(collar.operationCode, "S001");
  assert.deepEqual(collar.pieces[0].scannedBy.map((s) => s.operatorId), ["GR9"]);
  // Operators sorted by defects, first/last scan times set.
  assert.equal(r.operators[0].operatorId, "GR1");
  assert.ok(asha.firstAt < asha.lastAt);
});

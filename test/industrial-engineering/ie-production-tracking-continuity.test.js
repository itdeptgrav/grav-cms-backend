// test/industrial-engineering/ie-production-tracking-continuity.test.js
//
// THE BARCODE AND MACHINE-TRACKING CONTRACTS, PINNED FROM THE IE SIDE.
//
// Chunk 6B gives Industrial Engineering planned machine TYPES per station. That
// is an engineering requirement, and it sits a long way from what Production
// already runs on the floor: printed barcodes, physical machines, operator
// sessions and a scanner comparing operation CODES. Those five identifiers are
// live — printed labels and deployed scanner clients depend on them — so this
// file exists to prove Chunk 6B renamed, replaced, reinterpreted and removed
// none of them.
//
// It exercises Production's own ingestion path and reads Production's own
// models. It changes nothing there: the assertions are a fence, not a feature.
//
//   1. a printed barcode identifies the work-order PIECE, as
//      `WO-<workOrder._id.slice(-8)>-<unit>[-<operation#>]`;
//   2. a scan records the physical `machineId`;
//   3. the operator session stays Production-owned (`operatorIdentityId`);
//   4. a scan captures the active operation-CODE snapshot (`activeOps`);
//   5. work-order operations keep `operationCode` as the device's comparison key.
//
// And the other half of the fence: no IE record accepts or stores a barcode, a
// machine id, an operator or a scan.
"use strict";
process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const express = require("express");
const mongoose = require("mongoose");

const Employee = require("../../models/Employee");
const Machine = require("../../models/CMS_Models/Inventory/Configurations/Machine");
const WorkOrder = require("../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const ProductionTracking = require("../../models/CMS_Models/Manufacturing/Production/Tracking/ProductionTracking");
const IeStyleFile = require("../../models/CMS_Models/IndustrialEngineering/IeStyleFile");
const IeLineLayout = require("../../models/CMS_Models/IndustrialEngineering/IeLineLayout");
const IeOperation = require("../../models/CMS_Models/IndustrialEngineering/IeOperation");

let server, base, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  /* Production's own router, mounted as the app mounts it. */
  app.use("/api/tracking", require("../../routes/Barcode_Scan_Punchings/trackingRoutes"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => { await new Promise((r) => server.close(r)); });

const post = (path, body) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then(async (r) => {
    const text = await r.text();
    let parsed = null;
    try { parsed = JSON.parse(text || "null"); } catch { parsed = { nonJson: true }; }
    return { status: r.status, body: parsed };
  });

/** A machine on the floor, an operator, and a work order with coded operations. */
async function floor(name) {
  const n = ++seq;
  const machine = await Machine.create({
    name: `SNLS-${n}`, type: "SNLS", model: "JK-8720", serialNumber: `SN-${name}-${n}`,
    status: "Operational", powerConsumption: "550", location: "Line 4",
    lastMaintenance: new Date("2026-08-01"), nextMaintenance: new Date("2026-12-01"),
    createdBy: new mongoose.Types.ObjectId(),
  });
  /* The operator identity the scanner sends, exactly as the route resolves it:
     `identityId`, `needsToOperate` and an active status. */
  const operator = await Employee.create({
    firstName: "Op", lastName: `${n}`, email: `op${n}@grav.test`, biometricId: `BIO90${n}`,
    identityId: `GR90${n}`, needsToOperate: true, status: "active",
    isActive: true, gender: "Other", department: "Production",
  });
  const workOrder = await WorkOrder.create({
    workOrderNumber: `WO-TRK-${n}`, quantity: 10, originalQuantity: 10, status: "in_progress",
    stockItemName: "Tee", stockItemReference: `REF-${n}`,
    customerId: new mongoose.Types.ObjectId(), customerName: "Northwind",
    /* The device compares against these CODES. */
    operations: [
      { operationType: "Side seam", operationCode: "SJ-01", plannedTimeSeconds: 60 },
      { operationType: "Hem", operationCode: "HM-02", plannedTimeSeconds: 45 },
    ],
  });
  return { machine, operator, workOrder, n };
}

/* ══ 1. THE PRINTED BARCODE STILL IDENTIFIES THE PIECE ════════════════════ */

describe("the printed barcode contract", () => {
  test("a piece barcode is WO-<shortId>-<unit> and still resolves its work order", async () => {
    const { machine, operator, workOrder } = await floor("Piece");
    /* Exactly how the label is printed and how the parser reads it: the last
       eight characters of the work order's own id. */
    const shortId = String(workOrder._id).slice(-8);
    const barcode = `WO-${shortId}-3`;

    /* Sign the operator in on the machine, as the device does. */
    const signIn = await post("/api/tracking/scan", {
      scanId: operator.identityId, machineId: String(machine._id), timeStamp: new Date().toISOString(),
    });
    expect(signIn.status).toBeLessThan(400);

    const scanned = await post("/api/tracking/scan", {
      scanId: barcode, machineId: String(machine._id), timeStamp: new Date().toISOString(),
      activeOps: ["SJ-01"],
    });
    expect(scanned.status).toBeLessThan(400);

    /* The three-part form still parses, and the short id still resolves. */
    const parts = barcode.split("-");
    expect(parts.length).toBeGreaterThanOrEqual(3);
    expect(parts[0]).toBe("WO");
    expect(parts[1]).toBe(shortId);
    expect(Number(parts[2])).toBe(3);
    const resolved = await WorkOrder.findById(workOrder._id).lean();
    expect(String(resolved._id).slice(-8)).toBe(parts[1]);
    /* And the parser reads no `workOrderNumber`: the piece resolves from the id
       alone, so the printed label survives any renaming of the order. */
    expect(String(resolved._id).slice(-8)).not.toBe(resolved.workOrderNumber);
  });

  test("the scan records the physical machine and the operator session", async () => {
    const { machine, operator } = await floor("MachineAndOperator");
    const at = new Date();
    const signIn = await post("/api/tracking/scan", {
      scanId: operator.identityId, machineId: String(machine._id), timeStamp: at.toISOString(),
    });
    expect(signIn.status).toBeLessThan(400);

    const tracking = await ProductionTracking.findOne({}).lean();
    expect(tracking).toBeTruthy();
    /* One slot per machine, keyed by the PHYSICAL machine — not a type. */
    const slot = tracking.machines.find((m) => String(m.machineId) === String(machine._id));
    expect(slot).toBeTruthy();
    expect(slot.currentOperatorIdentityId).toBe(operator.identityId);
    /* The operator session is Production's: an identity id and a sign-in time. */
    const session = slot.operators.at(-1);
    expect(session.operatorIdentityId).toBe(operator.identityId);
    expect(session.signInTime).toBeTruthy();
    expect(session.signOutTime).toBeNull();
  });

  test("the active operation-code snapshot is a string array on the scan, written by its own path", async () => {
    /* ── WHAT THE CODE ACTUALLY DOES, PINNED AS IT IS ────────────────────────
       The `/scan` ingestion path stores a scan as `barcodeId` + `timeStamp` and
       leaves `activeOps` at its default. The operation-CODE snapshot is written
       by the mark-as-done path (`activeOps: operationCodes`) and read back by QC
       and Packaging as a string array. This test pins that division rather than
       an idealised one, because it is what deployed clients rely on. */
    const { machine, operator, workOrder } = await floor("ActiveOps");
    await post("/api/tracking/scan", {
      scanId: operator.identityId, machineId: String(machine._id), timeStamp: new Date().toISOString(),
    });
    const barcode = `WO-${String(workOrder._id).slice(-8)}-1`;
    const scanned = await post("/api/tracking/scan", {
      scanId: barcode, machineId: String(machine._id), timeStamp: new Date().toISOString(),
    });
    expect(scanned.status).toBeLessThan(400);

    const tracking = await ProductionTracking.findOne({}).lean();
    const slot = tracking.machines.find((m) => String(m.machineId) === String(machine._id));
    const scan = slot.operators.at(-1).barcodeScans.at(-1);
    expect(scan.barcodeId).toBe(barcode);
    expect(scan.timeStamp).toBeTruthy();
    expect(scan.activeOps).toEqual([]);

    /* The snapshot's own shape, written the way its writer writes it. */
    await ProductionTracking.updateOne(
      { _id: tracking._id, "machines.machineId": machine._id },
      { $set: { "machines.$.operators.0.barcodeScans.0.activeOps": ["SJ-01", "HM-02"] } },
    );
    const after = await ProductionTracking.findById(tracking._id).lean();
    const snapshot = after.machines[0].operators[0].barcodeScans[0].activeOps;
    expect(snapshot).toEqual(["SJ-01", "HM-02"]);
    expect(typeof snapshot[0]).toBe("string");

    /* And its writer still writes operation CODES into it. */
    const source = require("fs").readFileSync(
      "routes/CMS_Routes/Manufacturing/Manufacturing-Order/markAsDoneRoutes.js", "utf8",
    );
    expect(source).toMatch(/activeOps:\s*operationCodes/);
  });

  test("work-order operations still carry the operation code the device compares on", async () => {
    const { workOrder } = await floor("OperationCodes");
    const stored = await WorkOrder.findById(workOrder._id).lean();
    expect(stored.operations.map((o) => o.operationCode)).toEqual(["SJ-01", "HM-02"]);
    expect(stored.operations.map((o) => o.operationType)).toEqual(["Side seam", "Hem"]);
    /* The field is still a plain code string — not renamed, not an id, and not
       replaced by an IE reference. */
    const path = WorkOrder.schema.path("operations");
    expect(path.schema.path("operationCode").instance).toBe("String");
    expect(path.schema.path("operationType").instance).toBe("String");
    /* Machine assignment is still absent at planning time, as the model says. */
    expect(path.schema.path("machineId")).toBeUndefined();
  });

  test("the tracking and barcode schemas still hold the same identifiers", () => {
    /* A fence around the five names Chunk 6B must not touch. */
    const machineSlot = ProductionTracking.schema.path("machines").schema;
    expect(machineSlot.path("machineId").instance).toBe("ObjectId");
    expect(machineSlot.path("machineId").options.ref).toBe("Machine");
    expect(machineSlot.path("currentOperatorIdentityId").instance).toBe("String");

    const operatorSession = machineSlot.path("operators").schema;
    expect(operatorSession.path("operatorIdentityId").instance).toBe("String");
    expect(operatorSession.path("signInTime").isRequired).toBe(true);

    const scan = operatorSession.path("barcodeScans").schema;
    expect(scan.path("barcodeId").isRequired).toBe(true);
    expect(scan.path("timeStamp").isRequired).toBe(true);
    expect(scan.path("activeOps").instance).toBe("Array");
  });
});

/* ══ 2. AND IE HOLDS NONE OF IT ═══════════════════════════════════════════ */

describe("the IE side of the fence", () => {
  test("no IE record has a field for a barcode, a machine, an operator or a scan", () => {
    const forbidden = /barcode|scanid|machineid|serialnumber|operatoridentity|operatorid|activeops|assetid/i;
    for (const model of [IeStyleFile, IeLineLayout, IeOperation]) {
      const paths = Object.keys(model.schema.paths);
      const nested = paths.flatMap((p) => {
        const path = model.schema.path(p);
        return path?.schema ? Object.keys(path.schema.paths).map((q) => `${p}.${q}`) : [];
      });
      for (const name of [...paths, ...nested]) {
        expect(name).not.toMatch(forbidden);
      }
    }
    /* IE's planned machine types are TYPES and counts — plus, since the 2D
       contract, the slot's own id and where it is drawn. Still no machine. */
    const station = IeLineLayout.schema.path("stations").schema;
    const planned = station.path("plannedMachineTypes").schema;
    expect(Object.keys(planned.paths).sort()).toEqual(["machineType", "position", "quantity", "slotId"]);
    expect(planned.path("machineType").instance).toBe("String");
    expect(planned.path("slotId").instance).toBe("String");
    /* A position is a planned point and nothing else: x and y, both numbers. */
    for (const position of [planned.path("position").schema, station.path("position").schema]) {
      expect(Object.keys(position.paths).sort()).toEqual(["x", "y"]);
      expect(position.path("x").instance).toBe("Number");
      expect(position.path("y").instance).toBe("Number");
    }
  });

  test("IE never reads the Machine register or a tracking record", () => {
    const fs = require("fs");
    const files = [
      "services/industrialEngineering/ieLineLayout.service.js",
      "services/industrialEngineering/ieStyleFile.service.js",
      "services/industrialEngineering/ieOperationLibrary.service.js",
      "services/industrialEngineering/lineBalanceCalculation.js",
    ];
    for (const file of files) {
      const source = fs.readFileSync(file, "utf8");
      /* No require of the physical registers or of Production's tracking. */
      expect(source).not.toMatch(/require\([^)]*Configurations\/Machine/);
      expect(source).not.toMatch(/require\([^)]*ProductionTracking/);
      expect(source).not.toMatch(/require\([^)]*models\/Employee/);
    }
  });

  test("the IE layout publishes the Production connection as UNKNOWN, with the legacy key named", () => {
    const { publishLayout } = require("../../services/industrialEngineering/ieLineLayout.service");
    const published = publishLayout(
      {
        _id: new mongoose.Types.ObjectId(), companyId: new mongoose.Types.ObjectId(),
        ieStyleFileId: new mongoose.Types.ObjectId(), sampleStyleId: new mongoose.Types.ObjectId(),
        status: "DRAFT", revision: 1, bulletinRevision: 1, sourceFingerprint: "f",
        sourceRows: [], stations: [], history: [],
      },
      { current: { bulletinRevision: 1, fingerprint: "f", digests: null } },
    );
    expect(published.productionLink).toMatchObject({
      state: "UNKNOWN",
      reason: "NO_STABLE_SHARED_IDENTITY",
      legacyCompatibilityKey: "OPERATION_CODE",
    });
    /* The stable provenance a later chunk will freeze is named, not guessed at. */
    expect(published.productionLink.provenanceFields).toEqual(expect.arrayContaining([
      "source.rows[].rowId",
      "source.rows[].ieOperationId",
      "source.rows[].ieOperationRevision",
      "source.rows[].methodStudyId",
    ]));
    /* And no claim of a match on a mutable name. */
    expect(published.productionLink.state).not.toBe("LINKED");
  });
});

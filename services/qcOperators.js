// services/qcOperators.js
//
// WHO MADE THE DEFECT — the join between a QC inspection and the scanner floor.
//
// A garment's barcode is scanned at every operation by the operator who did
// it (`productionevents`: operator badge, machine, the operation codes active
// on that machine at that moment, the time). QC later records a defect AT an
// operation code. Joining the two names the operator, and the time they had
// the piece, for each defect — which is the question this file answers, on
// demand, for one piece (`piece-operators`) and for a day (`operator-defects`).
//
// THREE THINGS THIS GETS RIGHT THAT THE FIRST VERSION DID NOT (24 Sep 2026):
//
// 1. It reads `productionevents`, the scanners' append-only source of truth,
//    not the `ProductionTracking` read model. The rollup regenerates that
//    document from the events every 60 s and only for shift days that HAVE
//    events, so a piece could be in one and not the other. Measured: every
//    barcode in tracking is also in the events; the reverse is not true.
//
// 2. A badge carries `biometricId` (GR0045) or `identityId` (GR045). The old
//    lookup resolved names by `identityId` alone, so three of the four
//    operators on the floor came back as a bare badge number.
//
// 3. It is HONEST about attribution. An operator is named for a defect only
//    when they scanned THAT operation code on THAT piece. When nobody did —
//    the operation was never scanned, or the device sent no operation
//    snapshot — the defect is reported as unattributed, beside whoever DID
//    scan the piece, rather than pinned on the nearest name. On real data
//    (24 Sep 2026) that is most of them, and a report that guessed would be
//    a report that blamed the wrong person.

const ProductionEvent = require("../models/CMS_Models/Manufacturing/Production/Barcode/ProductionEvent");
const Employee        = require("../models/Employee");
const Machine         = require("../models/CMS_Models/Inventory/Configurations/Machine");

const norm = (code) => String(code || "").trim().toLowerCase();
const uniq = (list) => [...new Set(list.filter(Boolean))];

/** A person's display name from an Employee row. */
function employeeName(e) {
  return [e.firstName, e.middleName, e.lastName].filter(Boolean).join(" ").trim();
}

/**
 * Names for a set of badge ids, tried against BOTH identity fields.
 * @returns {Promise<Map<string,string>>} badge → name (missing badges absent)
 */
async function resolveOperatorNames(operatorIds) {
  const ids = uniq(operatorIds.map((x) => String(x || "").trim()));
  if (!ids.length) return new Map();
  const rows = await Employee.find({ $or: [{ biometricId: { $in: ids } }, { identityId: { $in: ids } }] })
    .select("biometricId identityId firstName middleName lastName").lean().catch(() => []);
  const out = new Map();
  for (const e of rows) {
    const name = employeeName(e);
    if (!name) continue;
    if (e.biometricId && ids.includes(e.biometricId)) out.set(e.biometricId, name);
    if (e.identityId && ids.includes(e.identityId)) out.set(e.identityId, name);
  }
  return out;
}

/**
 * Every scan of each barcode, oldest first, with the operator's real name and
 * the machine's name.
 *
 * @param {string[]} barcodes
 * @returns {Promise<Map<string, Array<{operatorId, operatorName, machineId, machineName, activeOps, scanTime}>>>}
 */
async function scansForBarcodes(barcodes) {
  const list = uniq((barcodes || []).map((b) => String(b || "").trim()));
  const out = new Map(list.map((b) => [b, []]));
  if (!list.length) return out;

  const events = await ProductionEvent.find({ type: "scan", barcodeId: { $in: list } })
    .select("barcodeId operatorId operatorName machineId activeOps scanTime")
    .sort({ scanTime: 1 })
    .lean();
  if (!events.length) return out;

  const [names, machines] = await Promise.all([
    resolveOperatorNames(events.map((e) => e.operatorId)),
    Machine.find({ _id: { $in: uniq(events.map((e) => e.machineId).map(String)) } }).select("name").lean().catch(() => []),
  ]);
  const machineName = new Map(machines.map((m) => [String(m._id), m.name || ""]));

  for (const e of events) {
    const operatorId = String(e.operatorId || "").trim();
    out.get(e.barcodeId).push({
      operatorId,
      // The device's own name hint is a fallback only — it has never been the authority.
      operatorName: names.get(operatorId) || e.operatorName || operatorId || "Unknown",
      machineId: e.machineId ? String(e.machineId) : "",
      machineName: machineName.get(String(e.machineId)) || "",
      activeOps: Array.isArray(e.activeOps) ? e.activeOps.filter(Boolean) : [],
      scanTime: e.scanTime,
    });
  }
  return out;
}

/**
 * The scans that attribute one defect: those whose active operations include
 * the defect's operation code. Pure.
 */
function scansAtOperation(scans, operationCode) {
  const code = norm(operationCode);
  if (!code) return [];
  return (scans || []).filter((s) => (s.activeOps || []).some((c) => norm(c) === code));
}

/**
 * One inspection's defects, each with its attribution. Pure.
 *
 * @returns {Array<{operationCode, operationName, types, operators:[{operatorId, operatorName, machineName, scanTime}], attributed:boolean}>}
 */
function attributeDefects(defects, scans) {
  return (defects || []).map((d) => {
    const hits = scansAtOperation(scans, d.operationCode);
    /* One row per operator, at the FIRST time they scanned this operation on
       this piece; a piece scanned twice by the same person is one person. */
    const byOperator = new Map();
    for (const s of hits) {
      const prev = byOperator.get(s.operatorId);
      if (!prev || new Date(s.scanTime) < new Date(prev.scanTime)) {
        byOperator.set(s.operatorId, { operatorId: s.operatorId, operatorName: s.operatorName, machineName: s.machineName, scanTime: s.scanTime });
      }
    }
    return {
      operationCode: d.operationCode,
      operationName: d.operationName || "",
      types: (d.types || []).map((t) => ({ code: t.code, name: t.name || "", note: t.note || "" })),
      operators: [...byOperator.values()].sort((a, b) => new Date(a.scanTime) - new Date(b.scanTime)),
      attributed: byOperator.size > 0,
    };
  });
}

/**
 * THE DAY'S DEFECTS, BY OPERATOR. Pure — every input is handed in, so this is
 * unit-tested without a database and the route is only plumbing.
 *
 * @param {object} args
 * @param {Array}  args.inspections     non-passed QC inspections in the period
 * @param {Map}    args.scansByBarcode  from scansForBarcodes()
 * @param {Map}    args.workOrderById   String(workOrderId) → { workOrderNumber, stockItemName, ... }
 * @param {Map}    [args.orderById]     String(manufacturingOrderId) → { moNumber, customerName }
 */
function buildOperatorDefectReport({ inspections = [], scansByBarcode = new Map(), workOrderById = new Map(), orderById = new Map() }) {
  const operators = new Map();
  const unattributed = new Map(); // product|operation → bucket
  let defectOps = 0, attributedOps = 0;
  const defectivePieces = new Set();

  const pieceOf = (insp) => {
    const wo = workOrderById.get(String(insp.workOrderId || "")) || {};
    const mo = orderById.get(String(insp.manufacturingOrderId || "")) || {};
    return {
      barcode: insp.barcodeId,
      productName: wo.stockItemName || "Unknown product",
      workOrderNumber: wo.workOrderNumber || (insp.workOrderShortId ? `WO-${insp.workOrderShortId}` : ""),
      moNumber: mo.moNumber || (insp.moRequestId ? `MO-${insp.moRequestId}` : ""),
      customerName: mo.customerName || "",
      inspectedAt: insp.inspectedAt,
      inspectedBy: insp.inspectedByQCName || "",
      stageName: insp.stageName || "",
      status: insp.status,
    };
  };

  const productKey = (p) => `${p.productName}|${p.workOrderNumber}`;

  for (const insp of inspections) {
    if (insp.status === "passed") continue;
    const scans = scansByBarcode.get(insp.barcodeId) || [];
    const piece = pieceOf(insp);
    const defects = attributeDefects(insp.defects, scans);
    if (defects.length) defectivePieces.add(insp.barcodeId);

    for (const d of defects) {
      defectOps += 1;
      if (d.attributed) attributedOps += 1;

      const targets = d.attributed
        ? d.operators.map((o) => ({ key: o.operatorId, o }))
        : [{ key: "", o: null }];

      for (const { key, o } of targets) {
        let bucketRoot;
        if (o) {
          if (!operators.has(key)) {
            operators.set(key, { operatorId: o.operatorId, operatorName: o.operatorName, defects: 0, pieces: new Set(), products: new Map(), firstAt: null, lastAt: null });
          }
          const op = operators.get(key);
          op.defects += 1;
          op.pieces.add(insp.barcodeId);
          const t = new Date(o.scanTime);
          if (!op.firstAt || t < op.firstAt) op.firstAt = t;
          if (!op.lastAt || t > op.lastAt) op.lastAt = t;
          bucketRoot = op.products;
        } else {
          bucketRoot = unattributed;
        }

        const pk = productKey(piece);
        if (!bucketRoot.has(pk)) bucketRoot.set(pk, { productName: piece.productName, workOrderNumber: piece.workOrderNumber, moNumber: piece.moNumber, customerName: piece.customerName, defects: 0, pieces: new Set(), operations: new Map() });
        const prod = bucketRoot.get(pk);
        prod.defects += 1;
        prod.pieces.add(insp.barcodeId);

        const ok = norm(d.operationCode);
        if (!prod.operations.has(ok)) prod.operations.set(ok, { operationCode: d.operationCode, operationName: d.operationName, defects: 0, types: new Map(), pieces: [] });
        const opn = prod.operations.get(ok);
        opn.defects += 1;
        const typeList = d.types.length ? d.types : [{ code: "", name: "Not specified", note: "" }];
        for (const t of typeList) {
          const tk = t.code || t.name;
          const cur = opn.types.get(tk) || { code: t.code, name: t.note || t.name || t.code, count: 0 };
          cur.count += 1;
          opn.types.set(tk, cur);
        }
        opn.pieces.push({
          barcode: piece.barcode,
          types: typeList.map((t) => t.note || t.name || t.code),
          scanTime: o ? o.scanTime : null,
          machineName: o ? o.machineName : "",
          inspectedAt: piece.inspectedAt,
          inspectedBy: piece.inspectedBy,
          stageName: piece.stageName,
          status: piece.status,
          /* For an unattributed defect: who DID scan this piece, and at what
             operations — so the reader can still see who touched it without
             the report pretending one of them made this fault. */
          ...(o ? {} : {
            scannedBy: uniq(scans.map((s) => s.operatorId)).map((id) => {
              const mine = scans.filter((s) => s.operatorId === id);
              return { operatorId: id, operatorName: mine[0].operatorName, operations: uniq(mine.flatMap((s) => s.activeOps)), firstAt: mine[0].scanTime };
            }),
          }),
        });
      }
    }
  }

  const finishProducts = (map) => [...map.values()]
    .map((p) => ({
      ...p, pieces: p.pieces.size,
      operations: [...p.operations.values()]
        .map((o) => ({ ...o, types: [...o.types.values()].sort((a, b) => b.count - a.count) }))
        .sort((a, b) => b.defects - a.defects || a.operationCode.localeCompare(b.operationCode)),
    }))
    .sort((a, b) => b.defects - a.defects || a.productName.localeCompare(b.productName));

  const operatorRows = [...operators.values()]
    .map((o) => ({ ...o, pieces: o.pieces.size, products: finishProducts(o.products) }))
    .sort((a, b) => b.defects - a.defects || a.operatorName.localeCompare(b.operatorName));
  const unattributedRows = finishProducts(unattributed);

  return {
    summary: {
      defectivePieces: defectivePieces.size,
      defectOps,
      attributedOps,
      unattributedOps: defectOps - attributedOps,
      operators: operatorRows.length,
    },
    operators: operatorRows,
    unattributed: { defects: defectOps - attributedOps, products: unattributedRows },
  };
}

module.exports = { scansForBarcodes, resolveOperatorNames, scansAtOperation, attributeDefects, buildOperatorDefectReport };

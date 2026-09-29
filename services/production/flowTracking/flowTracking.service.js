// services/production/flowTracking/flowTracking.service.js
//
// Loads what flowWip.js needs and nothing more. The arithmetic stays in the
// pure module; this file decides WHICH records, always inside ONE company and,
// for the active view, ONE validated PPC planning line.
//
// ─── ROUTE SOURCE ───────────────────────────────────────────────────────────
// Only the Production execution basis embedded on each WorkOrder
// (`productionExecutionBases[]`). PPC publications and IE releases are not
// read here: Production's receipt already froze what applied.
//
// ─── COMPANY SCOPE ──────────────────────────────────────────────────────────
// `companyId` is the acting company the route resolved from the actor's own
// memberships (merchandisingCompanyMiddleware); never read from a request.
//   work orders   `salesLineLink.companyId` = company. A historical WorkOrder
//                 with no link is in scope for nobody (404 by id, never listed).
//   planning line PpcCapacityLine with this `companyId`.
//   scan events   only for the in-scope work orders' barcode keys.
// Every row a loader returns is checked against the company again here.
//
// ─── LINE SCOPE, NOT A FLOOR ────────────────────────────────────────────────
// The active view REQUIRES one `capacityLineId` and returns only work orders
// whose execution basis in force at `asOf` froze that line.
//
// The line is PROVED by either of two company-scoped facts:
//   · an execution basis on one of this company's WorkOrders froze it — the
//     embedded basis is self-contained historical proof (company, line id,
//     frozen lineRef/revision, display-only factoryRef), so historical flow
//     survives the current PpcCapacityLine being edited, retired or deleted;
//   · or the current PpcCapacityLine is this company's.
// Neither → the same 404 a foreign line gets, so probing ids reveals nothing.
// The current record, when present, only ENRICHES the response under
// `planningLineScope.current`; each work order keeps its own FROZEN
// `planningLineScope` (lineRef + revision as its basis froze them). A company-wide collection is never
// returned as though it were one floor. `factoryRef` is display text only.
// There is no site master and no planning-line → canvas mapping, so the
// response says `siteScope: not_modelled`, `physicalLineMapping: unavailable`.
//
// ─── MACHINE AND ZONE CONTEXT ───────────────────────────────────────────────
// Only from current SERVER-OWNED machine assignments on company-owned
// machines. `machineId` must be a machine this company owns; `zoneId` needs a
// canvas layout owned by this company (`organizationId` = its id — the shared
// "default" layout proves no owner, so zone narrowing fails closed with
// ZONE_CONTEXT_UNAVAILABLE) and counts only company-owned machines in the zone.
// A current assignment describes now: for an `asOf` more than
// CURRENT_ASOF_TOLERANCE_MS away, machine context is unavailable and machine or
// zone narrowing is refused (MACHINE_CONTEXT_REQUIRES_CURRENT_ASOF).

const {
  computeWorkOrderFlow,
  clampWindowMinutes,
  shortIdOf,
  routeFromExecutionBasis,
  reconcileOperationCodes,
  MACHINE_CONTEXT_SOURCE,
  SITE_SCOPE,
  PHYSICAL_LINE_MAPPING,
} = require("./flowWip");

// The statuses productionSyncService treats as live production.
const ACTIVE_WORK_ORDER_STATUSES = ["in_progress", "scheduled", "ready_to_start", "paused"];

const CURRENT_ASOF_TOLERANCE_MS = 2 * 60 * 1000;

const WORK_ORDER_FIELDS = "_id workOrderNumber quantity status salesLineLink.companyId operations.operationCode +productionExecutionBases";
const EVENT_FIELDS = "type barcodeId workOrderKey unitNumber activeOps scanTime machineId operatorId timeRecovered";

class FlowTrackingError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
  toResponse() {
    return { success: false, code: this.code, message: this.message };
  }
}

const isObjectId = (v) => /^[0-9a-f]{24}$/i.test(String(v || ""));
const idOf = (v) => (v == null ? null : String(v));
const ownedBy = (companyId) => (row) => idOf(row?.salesLineLink?.companyId ?? row?.companyId) === idOf(companyId);

/** The work-order filter every loader applies. Exported so it is tested. */
function workOrderScopeFilter(companyId) {
  const mongoose = require("mongoose");
  return { "salesLineLink.companyId": new mongoose.Types.ObjectId(String(companyId)) };
}

function defaultLoaders() {
  const mongoose = require("mongoose");
  const oid = (v) => new mongoose.Types.ObjectId(String(v));
  const WorkOrder = require("../../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
  const ProductionEvent = require("../../../models/CMS_Models/Manufacturing/Production/Barcode/ProductionEvent");
  const { PpcCapacityLine } = require("../../../models/CMS_Models/PPC/PpcCapacityLine");
  const Machine = require("../../../models/CMS_Models/Inventory/Configurations/Machine");
  const CanvasLayout = require("../../../models/CMS_Models/Manufacturing/Production/CanvasLayout");
  // Fail at construction, not at the first request: model files export in two
  // shapes (bare model vs `{ Model }`), and a wrong one would only surface live.
  for (const [name, model] of Object.entries({ WorkOrder, ProductionEvent, PpcCapacityLine, Machine, CanvasLayout })) {
    if (typeof model?.find !== "function") throw new TypeError(`flowTracking: ${name} did not resolve to a mongoose model`);
  }

  return {
    async workOrderById(companyId, id) {
      return WorkOrder.findOne({ ...workOrderScopeFilter(companyId), _id: oid(id) }).select(WORK_ORDER_FIELDS).lean();
    },
    async activeWorkOrders(companyId) {
      return WorkOrder.find({ ...workOrderScopeFilter(companyId), status: { $in: ACTIVE_WORK_ORDER_STATUSES } })
        .select(WORK_ORDER_FIELDS).lean();
    },
    /* Does any of this company's WorkOrders carry a basis that froze this
       line? A filter on the embedded path; `select: false` does not apply to
       filters, and nothing from the basis is returned. */
    async lineProvenByBasis(companyId, lineId) {
      const found = await WorkOrder.exists({
        ...workOrderScopeFilter(companyId),
        productionExecutionBases: { $elemMatch: { companyId: oid(companyId), "planningLine.capacityLineId": oid(lineId) } },
      });
      return Boolean(found);
    },
    /* Current server-owned assignments on this company's machines. */
    async currentAssignments(companyId, workOrderIds) {
      if (!workOrderIds.length) return [];
      return Machine.find({ "productionOwnership.companyId": oid(companyId), "productionAssignment.workOrderId": { $in: workOrderIds.map(oid) } })
        .select("+productionOwnership +productionAssignment").lean();
    },
    async ownedMachineIds(companyId, machineIds) {
      if (!machineIds.length) return [];
      const rows = await Machine.find({ _id: { $in: machineIds.map(oid) }, "productionOwnership.companyId": oid(companyId) }).select("_id").lean();
      return rows.map((r) => String(r._id));
    },
    /* Only a layout OWNED by this company — never the shared "default". */
    async companyCanvasLayout(companyId) {
      return CanvasLayout.findOne({ organizationId: String(companyId) })
        .select("organizationId machinePositions.machineId machinePositions.zoneId chamberTemplates.id").lean();
    },
    async capacityLine(companyId, lineId) {
      return PpcCapacityLine.findOne({ _id: oid(lineId), companyId: oid(companyId) })
        .select("companyId lineRef name revision status factoryRef").lean();
    },
    async scanEvents(workOrderIds, asOf) {
      if (!workOrderIds.length) return [];
      const keys = new Set();
      for (const id of workOrderIds) {
        const full = String(id).toLowerCase();
        const short = shortIdOf(full);
        for (const k of [full, short, full.toUpperCase(), short.toUpperCase()]) keys.add(k);
      }
      return ProductionEvent.find({ type: "scan", workOrderKey: { $in: [...keys] }, scanTime: { $lte: asOf } })
        .select(EVENT_FIELDS)
        .lean();
    },
    // Barcodes carry only the last 8 hex of the id. Two work orders sharing
    // them — in ANY company — cannot be told apart from a scan. Only the
    // colliding keys come back, never the other record.
    async collidingShortIds(workOrderIds) {
      const shorts = [...new Set(workOrderIds.map((id) => shortIdOf(id)))];
      if (!shorts.length) return new Set();
      const rows = await WorkOrder.aggregate([
        { $project: { s: { $toLower: { $substrCP: [{ $toString: "$_id" }, 16, 8] } } } },
        { $match: { s: { $in: shorts } } },
        { $group: { _id: "$s", n: { $sum: 1 } } },
        { $match: { n: { $gt: 1 } } },
      ]);
      return new Set(rows.map((r) => r._id));
    },
  };
}

function parseAsOf(raw) {
  if (raw == null || raw === "") return new Date();
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) throw new FlowTrackingError(400, "asOf is not a valid date", "INVALID_AS_OF");
  return d;
}

function requireCompany(companyId) {
  if (!isObjectId(companyId)) {
    throw new FlowTrackingError(403, "No acting company could be proved for this request.", "COMPANY_CONTEXT_REQUIRED");
  }
  return String(companyId);
}

function groupEvents(events) {
  const byKey = new Map();
  for (const ev of events) {
    const k = String(ev.workOrderKey || "").toLowerCase();
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(ev);
  }
  return (workOrderId) => {
    const full = String(workOrderId).toLowerCase();
    const short = shortIdOf(full);
    return [...(byKey.get(full) || []), ...(short !== full ? byKey.get(short) || [] : [])];
  };
}

function createFlowTrackingService(loaders = defaultLoaders(), { now = () => new Date() } = {}) {
  const isCurrent = (at) => Math.abs(now().getTime() - at.getTime()) <= CURRENT_ASOF_TOLERANCE_MS;

  /** Current assignments for these work orders — or why they do not apply. */
  async function assignmentContextFor(company, workOrderIds, at) {
    if (!isCurrent(at)) return { available: false, reason: "current_assignment_not_applicable_to_historical_asof", machines: [] };
    const machines = (await loaders.currentAssignments(company, workOrderIds))
      .filter((m) => String(m.productionOwnership?.companyId) === company && String(m.productionAssignment?.companyId) === company);
    return { available: true, reason: null, machines };
  }
  const machineContextOf = (ctx) => ({ source: MACHINE_CONTEXT_SOURCE, status: ctx.available ? "resolved" : "unavailable",
    reasons: ctx.reason ? [ctx.reason] : [] });

  async function evidenceFor(workOrders, at) {
    const ids = workOrders.map((w) => String(w._id));
    const [events, collisions] = await Promise.all([loaders.scanEvents(ids, at), loaders.collidingShortIds(ids)]);
    return { eventsFor: groupEvents(events), collisions };
  }

  /** One work order of the acting company, every edge. */
  async function workOrderFlow({ companyId, workOrderId, asOf, windowMinutes } = {}) {
    const company = requireCompany(companyId);
    if (!isObjectId(workOrderId)) throw new FlowTrackingError(400, "workOrderId must be a 24-character id", "INVALID_ID");
    const at = parseAsOf(asOf);
    const workOrder = await loaders.workOrderById(company, workOrderId);
    // Foreign, unlinked and missing all get the same answer, revealing nothing.
    if (!workOrder || !ownedBy(company)(workOrder)) {
      throw new FlowTrackingError(404, "No work order of your company has that id.", "NOT_FOUND");
    }
    const route = routeFromExecutionBasis({ workOrder, companyId: company, asOf: at });
    const { eventsFor, collisions } = await evidenceFor([workOrder], at);
    const assignmentContext = await assignmentContextFor(company, [String(workOrder._id)], at);
    return {
      ...computeWorkOrderFlow(workOrder, eventsFor(workOrder._id), {
        route, asOf: at, windowMinutes, keyCollision: collisions.has(shortIdOf(workOrder._id)), assignmentContext,
      }),
      machineContext: machineContextOf(assignmentContext),
    };
  }

  /**
   * Prove the requested planning line for this company — by an execution
   * basis, or by the current record — or refuse exactly as for a foreign id.
   */
  async function resolveLine(company, capacityLineId) {
    if (capacityLineId == null || capacityLineId === "") {
      throw new FlowTrackingError(400, "Choose one planning line (capacityLineId); a company-wide view is not a production floor.",
        "PLANNING_LINE_SCOPE_REQUIRED");
    }
    if (!isObjectId(capacityLineId)) throw new FlowTrackingError(400, "capacityLineId must be a 24-character id", "INVALID_ID");
    const [current, proven] = await Promise.all([
      loaders.capacityLine(company, capacityLineId),
      loaders.lineProvenByBasis(company, capacityLineId),
    ]);
    const own = current && idOf(current.companyId) === company && idOf(current._id) === String(capacityLineId) ? current : null;
    if (!own && !proven) {
      throw new FlowTrackingError(404, "No planning line of your company has that id.", "CAPACITY_LINE_NOT_FOUND");
    }
    return {
      capacityLineId: String(capacityLineId),
      proof: proven ? "production_execution_basis" : "current_record",
      currentRecordStatus: !own ? "missing" : own.status === "RETIRED" ? "retired" : "available",
      // Today's record, for display. NOT the revision any work order was
      // planned against — each work order's own frozen scope says that.
      current: own ? {
        lineRef: own.lineRef,
        revision: own.revision,
        name: own.name || "",
        factoryRefDisplay: own.factoryRef || "",
        factoryRefAuthoritative: false,
      } : null,
    };
  }

  /**
   * The active work of ONE planning line of the acting company, as each work
   * order's execution basis in force at `asOf` placed it.
   */
  async function activeFlow({ companyId, capacityLineId, asOf, windowMinutes, operationCode, zoneId, machineId } = {}) {
    const company = requireCompany(companyId);
    const lineScope = await resolveLine(company, capacityLineId);
    const at = parseAsOf(asOf);
    const window = clampWindowMinutes(windowMinutes);
    const code = operationCode ? String(operationCode).trim() : "";

    let machineIds = null;
    let zoneScope = { status: "not_requested" };
    if (zoneId || machineId) {
      if (!isCurrent(at)) {
        throw new FlowTrackingError(409, "Machine and zone context come from CURRENT assignments; they cannot narrow a historical asOf.",
          "MACHINE_CONTEXT_REQUIRES_CURRENT_ASOF");
      }
    }
    if (machineId) {
      if (!isObjectId(machineId)) throw new FlowTrackingError(400, "machineId must be a 24-character id", "INVALID_ID");
      const owned = await loaders.ownedMachineIds(company, [String(machineId)]);
      if (!owned.length) throw new FlowTrackingError(404, "No machine of your company has that id.", "MACHINE_NOT_FOUND");
      machineIds = new Set(owned);
    }
    if (zoneId) {
      const layout = await loaders.companyCanvasLayout(company);
      if (!layout || String(layout.organizationId) !== company) {
        throw new FlowTrackingError(409, "No floor layout owned by your company exists, so zones cannot be resolved.", "ZONE_CONTEXT_UNAVAILABLE");
      }
      const known = (layout.chamberTemplates || []).some((c) => c.id === String(zoneId))
        || (layout.machinePositions || []).some((p) => p.zoneId === String(zoneId));
      if (!known) throw new FlowTrackingError(404, "Zone not found on your company's floor plan.", "NOT_FOUND");
      const inZone = (layout.machinePositions || []).filter((p) => p.zoneId === String(zoneId) && p.machineId).map((p) => String(p.machineId));
      const owned = new Set(await loaders.ownedMachineIds(company, inZone));
      machineIds = machineIds ? new Set([...machineIds].filter((m) => owned.has(m))) : owned;
      zoneScope = { status: "resolved", zoneId: String(zoneId), layoutOwner: company, machineIds: [...owned].sort() };
    }

    const all = (await loaders.activeWorkOrders(company)).filter(ownedBy(company));
    const onLine = [];
    let withoutBasis = 0;
    for (const wo of all) {
      const route = routeFromExecutionBasis({ workOrder: wo, companyId: company, asOf: at });
      if (route.status !== "frozen") { withoutBasis++; continue; }
      if (route.planningLine.capacityLineId === lineScope.capacityLineId) onLine.push({ wo, route });
    }

    const { eventsFor, collisions } = await evidenceFor(onLine.map((x) => x.wo), at);
    const assignmentContext = await assignmentContextFor(company, onLine.map((x) => String(x.wo._id)), at);
    const narrowed = Boolean(code || machineIds);
    const results = [];
    let unresolvedEdges = 0;
    for (const { wo, route } of onLine) {
      const flow = computeWorkOrderFlow(wo, eventsFor(wo._id), {
        route, asOf: at, windowMinutes: window,
        keyCollision: collisions.has(shortIdOf(wo._id)),
        assignmentContext,
        context: { operationCode: code, machineIds },
      });
      if (narrowed) {
        unresolvedEdges += flow.edges.filter((e) => e.inContext === null).length;
        flow.edges = flow.edges.filter((e) => e.inContext === true);
        if (!flow.edges.length) continue;
      }
      results.push(flow);
    }

    return {
      generatedAt: at.toISOString(),
      windowMinutes: window,
      companyId: company,
      projection: "planning_line",
      planningLineScope: lineScope,
      siteScope: { ...SITE_SCOPE },
      physicalLineMapping: { ...PHYSICAL_LINE_MAPPING },
      machineContext: machineContextOf(assignmentContext),
      zoneScope,
      scope: { operationCode: code || null, machineId: machineId ? String(machineId) : null, zoneId: zoneId ? String(zoneId) : null, unresolvedEdges },
      // A count only: which company work orders could not be placed on ANY line.
      activeWorkOrdersWithoutExecutionBasis: withoutBasis,
      workOrders: results,
    };
  }

  /**
   * Read-only operation-code reconciliation for the acting company's active
   * work orders: device codes seen vs execution-basis codes expected.
   */
  async function operationCodeReconciliation({ companyId, asOf } = {}) {
    const company = requireCompany(companyId);
    const at = parseAsOf(asOf);
    const workOrders = (await loaders.activeWorkOrders(company)).filter(ownedBy(company));
    const { eventsFor } = await evidenceFor(workOrders, at);
    const rows = workOrders.map((wo) => reconcileOperationCodes(
      wo, eventsFor(wo._id), routeFromExecutionBasis({ workOrder: wo, companyId: company, asOf: at }), { asOf: at },
    ));
    const tally = {};
    for (const r of rows) for (const reason of r.blockingReasons) tally[reason] = (tally[reason] || 0) + 1;
    return {
      generatedAt: at.toISOString(),
      companyId: company,
      workOrders: rows.length,
      projectable: rows.filter((r) => r.projectable).length,
      blockingReasonCounts: tally,
      rows,
    };
  }

  return { workOrderFlow, activeFlow, operationCodeReconciliation };
}

// Built on first use, so requiring this module never loads a mongoose model.
let defaultService = null;
function flowTrackingService() {
  if (!defaultService) defaultService = createFlowTrackingService();
  return defaultService;
}

module.exports = {
  ACTIVE_WORK_ORDER_STATUSES,
  FlowTrackingError,
  createFlowTrackingService,
  defaultLoaders,
  flowTrackingService,
  workOrderScopeFilter,
};

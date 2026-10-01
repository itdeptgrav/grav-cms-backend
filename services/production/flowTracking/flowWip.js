// services/production/flowTracking/flowWip.js
//
// PRODUCTION FLOW TRACKING, PHASE 1 — how many distinct garments are waiting
// between two consecutive operations of one work order.
//
// Pure. No database, no Express, no clock: the caller hands in the work order,
// its Production execution bases, its scan events and
// `asOf`, so every rule below is testable on fixtures and a historical `asOf`
// answers exactly what the floor looked like then.
//
// ─── OPERATION IDENTITY: PRODUCTION'S EXECUTION BASIS, NEVER THE EDITABLE ROUTE
// docs/product/production-floor-ppc-integration-plan.md §4.4: "Never
// reinterpret historical scans using today's editable master data." So
// `WorkOrder.operations[]` is NOT read here at all. The ONLY route source is
// the Production execution basis embedded on the WorkOrder
// (`productionExecutionBases[]`, written solely by
// services/production/executionBasis/): Production's own, frozen receipt of a
// PPC SEWING publication, carrying the IE release route copied at receipt.
//
// A PPC publication on its own is planning input, not a Production release,
// and is no longer read by flow tracking.
//
// The basis applied is the version in force AT `asOf` (effectiveFrom ≤ asOf <
// effectiveUntil), so a successor, or any later edit to the WorkOrder, the PPC
// plan or the IE library, cannot change a historical answer. No basis in force
// → no edges, and the work order is `unknown` with
// `production_execution_basis_unavailable`. There is no fallback.
//
// The stable operation identity is the frozen bulletin `rowId`; order is the
// frozen `sequence`. A scan's `activeOps` is scan-time EVIDENCE tied to a
// frozen step only by EXACT equality (trimmed, case-insensitive) with that
// step's frozen `operationCode`, reported as `identityBasis:
// "frozen_release_operation_code"`. Nothing is mapped by similarity, name or
// position: `CT007` never becomes `P001`.
//
// ─── SCOPE: A PPC PLANNING LINE, NOT A FLOOR ────────────────────────────────
// The basis names a PPC capacity (planning) line. It is not a physical
// Production line and has no mapping to the canvas; there is no site master.
// Every flow says so: `siteScope.status: "not_modelled"`,
// `physicalLineMapping.status: "unavailable"`.
//
// ─── PIECE IDENTITY ─────────────────────────────────────────────────────────
// A piece is (workOrderId, unitNumber); membership at an operation is keyed
// (workOrderId, unitNumber, frozen rowId). The barcode STRING is not the key:
// `WO-359e717d-011`, `WO-359e717d-11` and the 24-hex form are one garment.
// Every repeat — device retry, operator rescan, a later rework pass — lands on
// the same key, so no repeat can raise WIP.
//
// Manual `production-completion/mark-done` records are NOT read: the durable
// plan keeps device scans and manual completion as distinct meanings until a
// reconciliation proves a shared metric.
//
// ─── FORMULA ────────────────────────────────────────────────────────────────
// For consecutive frozen rows i → i+1, with C_k the set of units completed at
// row k (first attributed scan at or before asOf):
//
//   completedUpstream   = |C_i|
//   completedDownstream = |C_i+1|
//   wipPieces           = |{ u ∈ C_i : u ∉ C_i+1  and  u ∉ C_k for every k > i+1 }|
//
// A set difference, never a subtraction, so it cannot go negative; a unit
// completed downstream without an upstream record is `downstreamWithoutUpstream`.
//
// ─── WHAT EVIDENCE MAKES A ZERO REAL (per edge, never per work order) ───────
// Absence of scans is absence of evidence, not zero production. Each edge is
// judged on ITS OWN two operations; scans elsewhere in the work order prove
// nothing about an edge they do not touch.
//
//   upstream 0, downstream 0 → unknown, `edge_has_no_reporting_evidence`
//   upstream 0, downstream >0 → unknown, `upstream_not_recorded`
//   upstream >0, downstream 0 → counts, but `estimated`,
//                               `downstream_has_no_reporting_evidence`: the
//                               pieces are real, yet "none moved on" and "the
//                               next station does not report" look the same
//   upstream >0, downstream >0 → `calculated`. Both stations demonstrably
//                               report for this work order, so a wipPieces of
//                               0 here is a REAL zero: every piece the
//                               upstream station reported has been reported
//                               downstream (or further on).
//
// Unknown counts are `null`, never 0.
//
// ─── MACHINE / ZONE CONTEXT: SERVER-OWNED ASSIGNMENTS ONLY ──────────────────
// Which machine is doing an operation NOW is read from the Machine's current
// server-owned assignment (services/production/machineAssignment), which names
// the WorkOrder, the execution basis and the frozen operation row. A machine
// counts for a step only when all three match the basis this flow was built
// on. Historical scan machine ids and heartbeat `activeOps` are evidence only
// and are never read here. A current assignment describes NOW, so a
// historical `asOf` reports the context as unavailable rather than projecting
// today's floor onto the past.
//
// ─── ASSUMPTIONS (phase 1 — not business rules; see the report) ─────────────
// A1 Bypass. A unit already completed at a row LATER than i+1 is not waiting
//    between i and i+1 (skipped, or its scan was missed). `bypassedDownstream`.
// A2 Rework. Scans carry no rework marker (QC rework lives on DefectRecord and
//    is not joined here). A repeat at an operation is the same membership; the
//    FIRST completion is the arrival time.
// A3 Cancellation. No per-piece cancellation exists. A cancelled work order is
//    `unknown`; a unit outside 1..quantity is invalid and never counted.
// A4 Partial bundles. The scanner identifies single units, not bundles.
// A5 Bulletin rows are the sewing operation sequence. Frozen rows carry no
//    stage id, so the whole frozen route in the basis is taken as the SEWING
//    route Production received.
// A6 Confidence. `confirmed` is reserved for a physically verified count; no
//    such source exists, so it is never emitted.
// A7 Trend compares recent arrivals with recent departures. No movement at
//    either side in the window is `unknown`.

const CONFIDENCE = Object.freeze({
  CONFIRMED: "confirmed",
  CALCULATED: "calculated",
  ESTIMATED: "estimated",
  UNKNOWN: "unknown",
});

const TREND = Object.freeze({
  GROWING: "growing",
  SHRINKING: "shrinking",
  STABLE: "stable",
  UNKNOWN: "unknown",
});

const CONTEXT = Object.freeze({ UNAVAILABLE: "unavailable" });

const SITE_SCOPE = Object.freeze({ status: "not_modelled" });
const PHYSICAL_LINE_MAPPING = Object.freeze({ status: "unavailable" });

const IDENTITY_BASIS = "frozen_release_operation_code";

const DEFAULT_WINDOW_MINUTES = 60;
const MIN_WINDOW_MINUTES = 15;
const MAX_WINDOW_MINUTES = 8 * 60;

// |arrivals − departures| within this band is "stable": at least one piece,
// or 10% of the busier side, so a single-piece wobble is not a trend.
const STABLE_BAND_RATIO = 0.1;

const codeKeyOf = (code) => String(code ?? "").trim().toLowerCase();
const idOf = (v) => (v == null ? null : String(v));
const shortIdOf = (id) => String(id).slice(-8).toLowerCase();
const timeOf = (v) => (v == null ? NaN : new Date(v).getTime());

function normaliseActiveOps(raw) {
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw.flatMap((s) => String(s).split(",")) : String(raw).split(",");
  return list.map(codeKeyOf).filter(Boolean);
}

/** Does this barcode's work-order segment name this work order (8- or 24-hex)? */
function keyMatchesWorkOrder(workOrderKey, workOrderId) {
  const key = String(workOrderKey ?? "").trim().toLowerCase();
  if (!key) return false;
  const id = String(workOrderId).toLowerCase();
  return key === id || key === shortIdOf(id);
}

function clampWindowMinutes(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_WINDOW_MINUTES;
  return Math.min(MAX_WINDOW_MINUTES, Math.max(MIN_WINDOW_MINUTES, Math.round(n)));
}

/* ═══ FROZEN ROUTE: THE PRODUCTION EXECUTION BASIS ═══════════════════════ */

/** The execution-basis version in force at `asOf`: effectiveFrom ≤ asOf < effectiveUntil. */
function basisInForce(bases, asOfMs) {
  const hits = (bases || []).filter((b) => timeOf(b?.effectiveFrom) <= asOfMs
    && (b.effectiveUntil == null || asOfMs < timeOf(b.effectiveUntil)));
  return hits.length === 1 ? hits[0] : null; // none, or an impossible overlap: never pick one
}

/**
 * The frozen route that applied to ONE work order at `asOf`, from its own
 * embedded Production execution bases. Company is re-checked on the basis.
 *
 * @returns { status: "frozen"|"unavailable", reason, basis, planningLine, rows }
 */
function routeFromExecutionBasis({ workOrder, companyId, asOf }) {
  const unavailable = (reason) => ({ status: "unavailable", reason, basis: null, planningLine: null, rows: [] });
  const basis = basisInForce(workOrder?.productionExecutionBases, timeOf(asOf));
  if (!basis) return unavailable("production_execution_basis_unavailable");
  if (idOf(basis.companyId) !== idOf(companyId) || idOf(basis.workOrderId) !== idOf(workOrder._id)) {
    return unavailable("production_execution_basis_unavailable");
  }
  const rows = [...(basis.route || [])]
    .filter((r) => r && r.rowId)
    .sort((a, b) => Number(a.sequence) - Number(b.sequence))
    .map((r) => ({
      rowId: String(r.rowId),
      sequence: Number(r.sequence),
      ieOperationId: idOf(r.ieOperationId),
      ieOperationRevision: r.ieOperationRevision ?? null,
      operationCode: String(r.operationCode ?? "").trim(),
      operationName: String(r.operationName ?? "").trim(),
      standardTimeMinutes: Number.isFinite(Number(r.standardTimeMinutes)) && Number(r.standardTimeMinutes) > 0
        ? Number(r.standardTimeMinutes) : null,
      standardTimeSource: String(r.standardTimeSource ?? "").trim(),
    }));
  if (!rows.length) return unavailable("production_execution_basis_has_no_route");
  return {
    status: "frozen",
    reason: null,
    basis: {
      source: "production_execution_basis",
      executionBasisId: idOf(basis.basisId),
      basisRef: basis.basisRef,
      versionNo: basis.versionNo,
      state: basis.state,
      effectiveFrom: new Date(basis.effectiveFrom).toISOString(),
      effectiveUntil: basis.effectiveUntil ? new Date(basis.effectiveUntil).toISOString() : null,
      ieReleaseId: idOf(basis.ieRelease?.ieReleaseId),
      ieReleaseRef: basis.ieRelease?.releaseRef ?? null,
      ieReleaseVersionNo: basis.ieRelease?.versionNo ?? null,
      identityBasis: IDENTITY_BASIS,
    },
    planningLine: {
      source: "frozen_execution_basis",
      capacityLineId: idOf(basis.planningLine?.capacityLineId),
      lineRef: basis.planningLine?.lineRef ?? null,
      revision: basis.planningLine?.lineRevision ?? null,
      factoryRefDisplay: basis.planningLine?.factoryRefDisplay ?? "",
      factoryRefAuthoritative: false,
    },
    rows,
  };
}

/** Steps of a frozen route, with the problems that make a step unattributable. */
function operationSequence(route) {
  const rows = route?.status === "frozen" ? route.rows : [];
  const codeCounts = new Map();
  for (const r of rows) {
    const k = codeKeyOf(r.operationCode);
    if (k) codeCounts.set(k, (codeCounts.get(k) || 0) + 1);
  }
  return rows.map((r, index) => {
    const codeKey = codeKeyOf(r.operationCode);
    let problem = null;
    if (!codeKey) problem = "operation_code_missing";
    else if (codeCounts.get(codeKey) > 1) problem = "operation_code_ambiguous";
    return {
      operationId: r.rowId,
      position: index + 1,
      sequence: r.sequence,
      ieOperationId: r.ieOperationId,
      operationCode: r.operationCode,
      operationName: r.operationName,
      standardTimeMinutes: r.standardTimeMinutes,
      standardTimeSource: r.standardTimeSource,
      codeKey,
      problem,
    };
  });
}

/* ═══ SCANS → MEMBERSHIPS ═════════════════════════════════════════════════ */

function collectCompletions(workOrder, steps, events, asOfMs, windowStartMs = -Infinity) {
  const workOrderId = idOf(workOrder._id);
  const quantity = Number(workOrder.quantity) || 0;
  const byStep = new Map(steps.map((s) => [s.operationId, new Map()]));
  const recentOperatorsByStep = new Map(steps.map((s) => [s.operationId, new Set()]));
  const stepsByCode = new Map();
  for (const s of steps) {
    if (!s.codeKey) continue;
    if (!stepsByCode.has(s.codeKey)) stepsByCode.set(s.codeKey, []);
    stepsByCode.get(s.codeKey).push(s);
  }

  const quality = {
    scanEvents: 0,
    attributedScanEvents: 0,
    repeatScans: 0,
    invalidUnitScans: 0,
    unattributedScans: 0,
    futureScans: 0,
    recoveredTimestampScans: 0,
  };

  for (const ev of events || []) {
    if (ev?.type && ev.type !== "scan") continue;
    if (!keyMatchesWorkOrder(ev?.workOrderKey, workOrderId)) continue;
    quality.scanEvents++;

    const at = timeOf(ev.scanTime);
    if (!Number.isFinite(at)) { quality.invalidUnitScans++; continue; }
    if (at > asOfMs) { quality.futureScans++; continue; }

    const unit = Number(ev.unitNumber);
    if (!Number.isInteger(unit) || unit <= 0 || unit > quantity) {
      quality.invalidUnitScans++;
      continue;
    }

    const matched = [];
    for (const code of new Set(normaliseActiveOps(ev.activeOps))) {
      for (const s of stepsByCode.get(code) || []) matched.push(s);
    }
    if (!matched.length) { quality.unattributedScans++; continue; }

    quality.attributedScanEvents++;
    if (ev.timeRecovered) quality.recoveredTimestampScans++;

    for (const s of matched) {
      if (at >= windowStartMs && String(ev.operatorId || "").trim()) {
        recentOperatorsByStep.get(s.operationId).add(String(ev.operatorId).trim());
      }
      const units = byStep.get(s.operationId);
      const prior = units.get(unit);
      if (!prior) {
        units.set(unit, { firstAt: at, recovered: Boolean(ev.timeRecovered) });
        continue;
      }
      quality.repeatScans++;
      if (at < prior.firstAt) {
        prior.firstAt = at;
        prior.recovered = Boolean(ev.timeRecovered);
      }
    }
  }
  return { byStep, recentOperatorsByStep, quality };
}

/* ═══ MACHINE CONTEXT ═════════════════════════════════════════════════════ */

const MACHINE_CONTEXT_SOURCE = "server_owned_machine_assignment";

/** One side of an edge: the machines currently assigned to this frozen step. */
function sideContext(step, route, workOrderId, assignmentContext) {
  if (!assignmentContext?.available) {
    return { status: "unavailable", machineIds: [], assignments: [], reasons: [assignmentContext?.reason || "current_assignment_unavailable"] };
  }
  const basisId = route.basis?.executionBasisId;
  const here = (assignmentContext.machines || []).filter((m) => {
    const a = m.productionAssignment;
    return a && idOf(a.workOrderId) === idOf(workOrderId) && String(a.operationRowId) === String(step.operationId);
  });
  const current = here.filter((m) => idOf(m.productionAssignment.executionBasisId) === idOf(basisId));
  const stale = here.filter((m) => idOf(m.productionAssignment.executionBasisId) !== idOf(basisId));
  const assignments = current.map((m) => ({ machineId: idOf(m._id), assignmentId: idOf(m.productionAssignment.assignmentId),
    revision: m.productionAssignment.revision }));
  const reasons = stale.length ? [`assignment_on_other_basis_version:${stale.map((m) => idOf(m._id)).join(",")}`] : [];
  let status = current.length ? "assigned" : "unassigned";
  if (!current.length && stale.length) status = "unresolved";
  return { status, machineIds: assignments.map((a) => a.machineId).sort(), assignments, reasons };
}

/* ═══ TREND ═══════════════════════════════════════════════════════════════ */

function classifyTrend(arrivals, departures) {
  if (arrivals === 0 && departures === 0) return TREND.UNKNOWN;
  const band = Math.max(1, STABLE_BAND_RATIO * Math.max(arrivals, departures));
  const net = arrivals - departures;
  if (Math.abs(net) <= band) return TREND.STABLE;
  return net > 0 ? TREND.GROWING : TREND.SHRINKING;
}

const perHour = (count, windowMinutes) => Math.round((count / (windowMinutes / 60)) * 10) / 10;
const round1 = (value) => Math.round(value * 10) / 10;
const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());

/**
 * Predict whether the downstream operation can exhaust the current buffer.
 * SAM is used only when recent scans prove how many operators were working at
 * that operation in this same window. Otherwise the observed downstream rate
 * is the fallback. No operator count is inferred from machines or a line plan.
 */
function predictDependency({ wipPieces, arrivalRatePerHour, departureRatePerHour,
  upstreamStandardTimeMinutes, downstreamStandardTimeMinutes,
  upstreamActiveOperators, downstreamActiveOperators, windowMinutes }) {
  const samRate = (sam, operators) => Number.isFinite(sam) && sam > 0 && Number.isInteger(operators) && operators > 0
    ? round1((operators * 60) / sam) : null;
  const upstreamSamRatePerHour = samRate(upstreamStandardTimeMinutes, upstreamActiveOperators);
  const downstreamSamRatePerHour = samRate(downstreamStandardTimeMinutes, downstreamActiveOperators);
  const pacePct = (actual, expected) => Number.isFinite(actual) && Number.isFinite(expected) && expected > 0
    ? round1((actual / expected) * 100) : null;
  const upstreamPacePercent = pacePct(arrivalRatePerHour, upstreamSamRatePerHour);
  const downstreamPacePercent = pacePct(departureRatePerHour, downstreamSamRatePerHour);

  if (![wipPieces, arrivalRatePerHour, departureRatePerHour].every(Number.isFinite)) {
    return { status: "unavailable", reason: "scan_rates_unavailable", predictionBasis: null,
      upstreamSamRatePerHour, downstreamSamRatePerHour, upstreamPacePercent, downstreamPacePercent,
      feedRequirementRatePerHour: null, feedGapRatePerHour: null, minutesUntilRunout: null, withinSelectedWindow: null };
  }
  const feedRequirementRatePerHour = downstreamSamRatePerHour ?? departureRatePerHour;
  const predictionBasis = downstreamSamRatePerHour != null ? "frozen_sam_and_recent_operators" : "observed_downstream_rate";
  const feedGapRatePerHour = round1(feedRequirementRatePerHour - arrivalRatePerHour);
  if (!(feedGapRatePerHour > 0)) {
    return { status: "not_at_risk", reason: null, predictionBasis,
      upstreamSamRatePerHour, downstreamSamRatePerHour, upstreamPacePercent, downstreamPacePercent,
      feedRequirementRatePerHour, feedGapRatePerHour, minutesUntilRunout: null, withinSelectedWindow: false };
  }
  const minutesUntilRunout = wipPieces <= 0 ? 0 : Math.max(0, Math.round((wipPieces / feedGapRatePerHour) * 60));
  const withinSelectedWindow = minutesUntilRunout <= windowMinutes;
  return { status: withinSelectedWindow ? "starvation_risk" : "not_at_risk", reason: null, predictionBasis,
    upstreamSamRatePerHour, downstreamSamRatePerHour, upstreamPacePercent, downstreamPacePercent,
    feedRequirementRatePerHour, feedGapRatePerHour, minutesUntilRunout, withinSelectedWindow };
}

const NULL_COUNTS = Object.freeze({
  completedUpstream: null,
  completedDownstream: null,
  wipPieces: null,
  oldestWaitingSince: null,
  oldestWaitingAgeSeconds: null,
  arrivalRatePerHour: null,
  departureRatePerHour: null,
  downstreamWithoutUpstream: null,
  bypassedDownstream: null,
});

const UNAVAILABLE_PREDICTION = Object.freeze({
  status: "unavailable",
  reason: "scan_rates_unavailable",
  predictionBasis: null,
  upstreamSamRatePerHour: null,
  downstreamSamRatePerHour: null,
  upstreamPacePercent: null,
  downstreamPacePercent: null,
  feedRequirementRatePerHour: null,
  feedGapRatePerHour: null,
  minutesUntilRunout: null,
  withinSelectedWindow: null,
});

/* ═══ THE FLOW OF ONE WORK ORDER ══════════════════════════════════════════ */

/**
 * @param workOrder  lean WorkOrder: _id, workOrderNumber, quantity, status.
 *                   `operations[]` is deliberately ignored.
 * @param events     ProductionEvent-shaped scans (other work orders' are ignored)
 * @param options    { route: routeFromExecutionBasis(...) result, asOf, windowMinutes,
 *                     keyCollision, assignmentContext: { available, reason, machines },
 *                     context: { operationCode?: string, machineIds?: Set<string> } }
 */
function computeWorkOrderFlow(workOrder, events, options = {}) {
  if (!workOrder || workOrder._id == null) throw new TypeError("computeWorkOrderFlow needs a work order with an _id");
  const asOfMs = timeOf(options.asOf ?? Date.now());
  if (!Number.isFinite(asOfMs)) throw new TypeError("asOf is not a valid date");
  const windowMinutes = clampWindowMinutes(options.windowMinutes);
  const windowStartMs = asOfMs - windowMinutes * 60 * 1000;
  const route = options.route || { status: "unavailable", reason: "production_execution_basis_unavailable", basis: null, rows: [] };
  const contextCode = codeKeyOf(options.context?.operationCode);
  const contextMachines = options.context?.machineIds instanceof Set ? options.context.machineIds : null;

  const steps = operationSequence(route);
  const { byStep, recentOperatorsByStep, quality } = collectCompletions(workOrder, steps, events, asOfMs, windowStartMs);

  const header = {
    workOrderId: idOf(workOrder._id),
    workOrderNumber: workOrder.workOrderNumber || null,
    status: workOrder.status || null,
    quantity: Number(workOrder.quantity) || 0,
    generatedAt: iso(asOfMs),
    windowMinutes,
    route: { status: route.status, reason: route.reason || null, basis: route.basis || null },
    planningLineScope: route.planningLine || null,
    siteScope: { ...SITE_SCOPE },
    physicalLineMapping: { ...PHYSICAL_LINE_MAPPING },
  };

  if (route.status !== "frozen") {
    // No frozen identity: nothing to attribute a scan to, so no edge exists.
    return {
      ...header,
      confidence: CONFIDENCE.UNKNOWN,
      reasons: [route.reason || "production_execution_basis_unavailable"],
      operations: [],
      edges: [],
      dataQuality: quality,
    };
  }

  // Work-order level reasons apply to every edge.
  const orderReasons = [];
  if (workOrder.status === "cancelled") orderReasons.push("work_order_cancelled");
  if (!(Number(workOrder.quantity) > 0)) orderReasons.push("work_order_quantity_missing");
  if (options.keyCollision) orderReasons.push("work_order_key_collision");

  const edges = [];
  for (let i = 0; i + 1 < steps.length; i++) {
    const from = steps[i];
    const to = steps[i + 1];
    const up = byStep.get(from.operationId);
    const down = byStep.get(to.operationId);

    const upCtx = sideContext(from, route, workOrder._id, options.assignmentContext);
    const downCtx = sideContext(to, route, workOrder._id, options.assignmentContext);
    const currentContext = {
      source: MACHINE_CONTEXT_SOURCE,
      status: [upCtx.status, downCtx.status].includes("unavailable") ? "unavailable"
        : [upCtx.status, downCtx.status].includes("unresolved") ? "unresolved" : "resolved",
      upstreamMachineIds: upCtx.machineIds,
      downstreamMachineIds: downCtx.machineIds,
      upstream: upCtx,
      downstream: downCtx,
      reasons: [...new Set([...upCtx.reasons, ...downCtx.reasons])],
    };
    let inContext = !contextCode || from.codeKey === contextCode || to.codeKey === contextCode;
    if (inContext && contextMachines) {
      if (currentContext.status === "unavailable") inContext = null;
      else inContext = [...upCtx.machineIds, ...downCtx.machineIds].some((m) => contextMachines.has(m));
    }

    const base = {
      fromOperationId: from.operationId,
      toOperationId: to.operationId,
      fromSequence: from.sequence,
      toSequence: to.sequence,
      fromIeOperationId: from.ieOperationId,
      toIeOperationId: to.ieOperationId,
      fromOperationCode: from.operationCode,
      toOperationCode: to.operationCode,
      fromOperationName: from.operationName,
      toOperationName: to.operationName,
      upstreamStandardTimeMinutes: from.standardTimeMinutes,
      downstreamStandardTimeMinutes: to.standardTimeMinutes,
      upstreamStandardTimeSource: from.standardTimeSource,
      downstreamStandardTimeSource: to.standardTimeSource,
      upstreamActiveOperators: recentOperatorsByStep.get(from.operationId)?.size || 0,
      downstreamActiveOperators: recentOperatorsByStep.get(to.operationId)?.size || 0,
      currentContext,
      inContext,
    };

    const reasons = [...orderReasons];
    if (from.problem) reasons.push(`upstream_${from.problem}`);
    if (to.problem) reasons.push(`downstream_${to.problem}`);

    // Units seen at any row after the downstream one (assumption A1).
    const later = new Set();
    for (let k = i + 2; k < steps.length; k++) for (const u of byStep.get(steps[k].operationId).keys()) later.add(u);

    if (!reasons.length) {
      if (up.size === 0 && down.size === 0) reasons.push("edge_has_no_reporting_evidence");
      else if (up.size === 0) reasons.push("upstream_not_recorded");
    }
    if (reasons.length) {
      edges.push({ ...base, ...NULL_COUNTS, trend: TREND.UNKNOWN, confidence: CONFIDENCE.UNKNOWN,
        prediction: { ...UNAVAILABLE_PREDICTION }, reasons });
      continue;
    }

    let downstreamWithoutUpstream = 0;
    for (const u of down.keys()) if (!up.has(u)) downstreamWithoutUpstream++;

    let wip = 0;
    let bypassed = 0;
    let oldest = null;
    let oldestRecovered = false;
    let arrivals = 0;
    for (const [u, rec] of up) {
      if (rec.firstAt >= windowStartMs) arrivals++;
      if (down.has(u)) continue;
      if (later.has(u)) { bypassed++; continue; }
      wip++;
      if (oldest === null || rec.firstAt < oldest) { oldest = rec.firstAt; oldestRecovered = rec.recovered; }
    }
    let departures = 0;
    for (const rec of down.values()) if (rec.firstAt >= windowStartMs) departures++;

    if (down.size === 0) reasons.push("downstream_has_no_reporting_evidence");
    if (downstreamWithoutUpstream > 0) reasons.push("downstream_without_upstream");
    if (oldestRecovered) reasons.push("oldest_waiting_time_recovered");

    const arrivalRatePerHour = perHour(arrivals, windowMinutes);
    const departureRatePerHour = perHour(departures, windowMinutes);
    const prediction = predictDependency({
      wipPieces: wip, arrivalRatePerHour, departureRatePerHour,
      upstreamStandardTimeMinutes: from.standardTimeMinutes,
      downstreamStandardTimeMinutes: to.standardTimeMinutes,
      upstreamActiveOperators: base.upstreamActiveOperators,
      downstreamActiveOperators: base.downstreamActiveOperators,
      windowMinutes,
    });
    edges.push({
      ...base,
      completedUpstream: up.size,
      completedDownstream: down.size,
      wipPieces: wip,
      oldestWaitingSince: iso(oldest),
      oldestWaitingAgeSeconds: oldest === null ? null : Math.max(0, Math.round((asOfMs - oldest) / 1000)),
      arrivalRatePerHour,
      departureRatePerHour,
      downstreamWithoutUpstream,
      bypassedDownstream: bypassed,
      trend: classifyTrend(arrivals, departures),
      confidence: reasons.length ? CONFIDENCE.ESTIMATED : CONFIDENCE.CALCULATED,
      prediction,
      reasons,
    });
  }

  const known = edges.filter((e) => e.confidence !== CONFIDENCE.UNKNOWN);
  const flowReasons = [...orderReasons];
  if (quality.attributedScanEvents === 0) flowReasons.push(quality.scanEvents > 0 ? "scans_not_attributable" : "no_scan_data");
  let confidence = CONFIDENCE.UNKNOWN;
  if (known.length) confidence = known.every((e) => e.confidence === CONFIDENCE.CALCULATED) && known.length === edges.length
    ? CONFIDENCE.CALCULATED : CONFIDENCE.ESTIMATED;

  return {
    ...header,
    confidence,
    reasons: flowReasons,
    operations: steps.map((s) => ({
      operationId: s.operationId,
      sequence: s.sequence,
      ieOperationId: s.ieOperationId,
      operationCode: s.operationCode,
      operationName: s.operationName,
      standardTimeMinutes: s.standardTimeMinutes,
      standardTimeSource: s.standardTimeSource,
      activeOperatorsInWindow: recentOperatorsByStep.get(s.operationId)?.size || 0,
      completedPieces: s.problem ? null : byStep.get(s.operationId).size,
      problem: s.problem,
    })),
    edges,
    dataQuality: quality,
  };
}

/* ═══ OPERATION-CODE RECONCILIATION (diagnostic, read-only) ═══════════════ */

/**
 * What the devices sent against what the frozen route expects, for one work
 * order. Reports; never maps. `editableRouteCodes` is shown for comparison
 * only and is never used for attribution.
 */
function reconcileOperationCodes(workOrder, events, route, { asOf } = {}) {
  const asOfMs = timeOf(asOf ?? Date.now());
  const observed = new Map();
  for (const ev of events || []) {
    if (ev?.type && ev.type !== "scan") continue;
    if (!keyMatchesWorkOrder(ev?.workOrderKey, workOrder._id)) continue;
    if (timeOf(ev.scanTime) > asOfMs) continue;
    for (const raw of normaliseActiveOps(ev.activeOps)) observed.set(raw, (observed.get(raw) || 0) + 1);
  }
  const steps = operationSequence(route);
  const expected = [...new Set(steps.map((s) => s.codeKey).filter(Boolean))];
  const duplicated = [...new Set(steps.filter((s) => s.problem === "operation_code_ambiguous").map((s) => s.codeKey))];
  const missingCodeRows = steps.filter((s) => s.problem === "operation_code_missing").map((s) => s.operationId);
  const expectedSet = new Set(expected);
  const observedCodes = [...observed.keys()].sort();
  const matched = observedCodes.filter((c) => expectedSet.has(c));
  const unmatchedDevice = observedCodes.filter((c) => !expectedSet.has(c));

  const blocking = [];
  if (route?.status !== "frozen") blocking.push(route?.reason || "production_execution_basis_unavailable");
  if (workOrder.status === "cancelled") blocking.push("work_order_cancelled");
  if (route?.status === "frozen") {
    if (steps.length < 2) blocking.push("frozen_route_has_fewer_than_two_operations");
    if (duplicated.length) blocking.push("frozen_route_codes_duplicated");
    if (missingCodeRows.length) blocking.push("frozen_route_codes_missing");
    if (!observedCodes.length) blocking.push("no_scan_data");
    else if (!matched.length) blocking.push("no_device_code_matches_frozen_route");
  }

  return {
    workOrderId: idOf(workOrder._id),
    workOrderNumber: workOrder.workOrderNumber || null,
    status: workOrder.status || null,
    route: { status: route?.status || "unavailable", reason: route?.reason || null, basis: route?.basis || null },
    observedDeviceCodes: observedCodes.map((c) => ({ code: c, scans: observed.get(c) })),
    expectedFrozenRouteCodes: expected,
    matchedCodes: matched,
    unmatchedDeviceCodes: unmatchedDevice,
    duplicatedRouteCodes: duplicated,
    rowsWithoutCode: missingCodeRows,
    editableRouteCodes: (workOrder.operations || []).map((o) => String(o?.operationCode ?? "").trim()).filter(Boolean),
    projectable: blocking.length === 0,
    blockingReasons: blocking,
  };
}

module.exports = {
  CONFIDENCE,
  TREND,
  CONTEXT,
  IDENTITY_BASIS,
  MACHINE_CONTEXT_SOURCE,
  SITE_SCOPE,
  PHYSICAL_LINE_MAPPING,
  DEFAULT_WINDOW_MINUTES,
  MIN_WINDOW_MINUTES,
  MAX_WINDOW_MINUTES,
  clampWindowMinutes,
  classifyTrend,
  computeWorkOrderFlow,
  keyMatchesWorkOrder,
  operationSequence,
  predictDependency,
  reconcileOperationCodes,
  routeFromExecutionBasis,
  shortIdOf,
};

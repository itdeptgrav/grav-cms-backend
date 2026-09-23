// services/ppc/lineRouteApplicability.service.js
//
// DOES THIS PLAN'S FROZEN IE ROUTE APPLY TO THIS EXACT SALES LINE?
//
// ── THE CHAIN, AND WHERE EACH LINK COMES FROM ───────────────────────────────
// Every link is read by id inside the acting company, from what the planning
// file FROZE — never the line's current pack, the style's current release, or
// anything matched by name, style code, product or order number.
//
//   planning file            company + permanent `orderLineRef`
//     └─ sourceBasis.executionPackId / executionPackVersionNo
//          └─ ExecutionPack.contents.salesHandover.versionId / versionNo
//               └─ SalesHandoverVersion — Sales' approved statement of THIS
//                  line: its `lineRef`, its style (`sampleStyleId`), and (when
//                  Sales states them) its special-process requirements
//     └─ sourceBasis.ieReleaseId
//          └─ IE's published process route for that exact release, and the
//             style it was engineered for
//
// Only when every link is present, agrees with the others, and the line's
// stated special processes match the route, is the route this line's. Any
// missing, contradictory, historical-UNKNOWN or unreadable link is a named
// blocker — PPC never chooses applicability on IE's or Sales' behalf.
//
// ── WHAT THIS DOES NOT DO ───────────────────────────────────────────────────
// It writes nothing. It publishes no stage, reads no actuals, books nothing
// and releases nothing. The Sales-line ↔ WorkOrder bridge is not consulted:
// a WorkOrder exists only after planning and carries no process requirement,
// so it cannot be evidence of which processes a line needs.
"use strict";

const mongoose = require("mongoose");

const { ExecutionPack } = require("../../models/CMS_Models/Merchandising/ExecutionPack");
const SalesHandoverVersion = require("../../models/CMS_Models/Sales/SalesHandoverVersion");
const requirements = require("./lineProcessRequirements");

const str = (v) => String(v ?? "").trim();
const isId = (v) => mongoose.Types.ObjectId.isValid(str(v)) && /^[0-9a-f]{24}$/i.test(str(v));
const oid = (v) => new mongoose.Types.ObjectId(str(v));

const STATE = Object.freeze({ PROVEN: "PROVEN", BLOCKED: "BLOCKED", UNREADABLE: "UNREADABLE" });

/**
 * Every named reason, with who can resolve it and the sentence a planner
 * reads. `kind` says which of the four failure families it belongs to.
 */
const REASONS = Object.freeze({
  RELEASE_MISSING: { kind: "MISSING", owner: "Industrial Engineering",
    message: "This plan froze no IE release, so there is no approved route to check against the line." },
  ROUTE_UNKNOWN: { kind: "UNKNOWN", owner: "Industrial Engineering",
    message: "The IE release this plan froze declares no approved process route (a historical release). Nothing is guessed from operation names." },
  REQUIREMENT_VERSION_MISSING: { kind: "MISSING", owner: "Merchandising",
    message: "The execution pack this plan froze does not name the Sales handover version it was built from." },
  REQUIREMENT_LINE_MISMATCH: { kind: "CONTRADICTORY", owner: "Merchandising",
    message: "The Sales handover version behind this plan's execution pack belongs to a different order line." },
  REQUIREMENT_WITHDRAWN: { kind: "CONTRADICTORY", owner: "Sales",
    message: "Sales cancelled the handover version this plan was built from." },
  REQUIREMENT_SUPERSEDED: { kind: "CONTRADICTORY", owner: "PPC",
    message: "Sales has issued a newer handover version for this line since this plan was frozen. Plan against it through a successor planning file." },
  STYLE_UNPROVEN: { kind: "MISSING", owner: "Sales",
    message: "The Sales handover version does not name the approved style, so the IE release cannot be shown to be this line's garment." },
  STYLE_MISMATCH: { kind: "CONTRADICTORY", owner: "Industrial Engineering",
    message: "The IE release this plan froze was engineered for a different style than the one Sales approved for this line." },
  RELEASE_VERSION_MISMATCH: { kind: "CONTRADICTORY", owner: "Industrial Engineering",
    message: "The IE release read back is not the release version this plan froze." },
  SCHEDULE_RELEASE_MISMATCH: { kind: "CONTRADICTORY", owner: "PPC",
    message: "The saved schedule was built on a different IE release than this plan froze." },
  LINE_REQUIREMENT_NOT_STATED: { kind: "MISSING", owner: "Sales",
    message: `${requirements.NOT_STATED_DETAIL} IE's route is per style, so it cannot be accepted as this line's without that statement.` },
  LINE_PROCESS_UNMATCHABLE: { kind: "CONTRADICTORY", owner: "Sales",
    message: "Sales states this line requires a process named only in free text. No IE route stage can be shown to be it, so PPC cannot plan it." },
  REQUIREMENT_ROUTE_MISMATCH: { kind: "CONTRADICTORY", owner: "Industrial Engineering",
    message: "The line's approved special processes do not match the IE route. IE must issue a matching technical basis; PPC cannot override it." },
  SOURCE_UNREADABLE: { kind: "UNREADABLE", owner: null,
    message: "A source needed to prove this line's route could not be read. This is a failed read, not a missing fact — nothing has been assumed." },
});

/** What the route says about one process: REQUIRED, NOT_APPLICABLE, or NOT_DECLARED. */
function routeSays(stages, process) {
  const own = (stages || []).filter((s) => s.process === process);
  if (own.some((s) => s.applicability === "REQUIRED")) return "REQUIRED";
  if (own.length) return "NOT_APPLICABLE";
  return "NOT_DECLARED";
}

/**
 * The line's stated special processes against the route:
 *   line REQUIRED     + route REQUIRED                    → match
 *   line REQUIRED     + route NOT_APPLICABLE or silent    → mismatch (no stage to plan it on)
 *   line NOT_REQUIRED + route REQUIRED                    → mismatch (a stage the buyer did not order)
 *   line NOT_REQUIRED + route NOT_APPLICABLE or silent    → match (nothing to schedule)
 *   line not stated                                        → unproven
 * A silent route is never read as NOT_APPLICABLE; it only fails to add a stage.
 */
function compareProcesses(statement, stages) {
  return requirements.SPECIAL_PROCESSES.map((process) => {
    const wanted = statement?.processes?.[process];
    const route = routeSays(stages, process);
    const line = Object.values(requirements.LINE_REQUIREMENT).includes(wanted) ? wanted : "NOT_STATED";
    let verdict = "UNPROVEN";
    if (line === "REQUIRED") verdict = route === "REQUIRED" ? "MATCH" : "MISMATCH";
    if (line === "NOT_REQUIRED") verdict = route === "REQUIRED" ? "MISMATCH" : "MATCH";
    return { process, line, route, verdict };
  });
}

function outcome(state, reason, evidence, extra = {}) {
  const r = reason ? REASONS[reason] : null;
  return {
    state,
    reason: reason || null,
    kind: r?.kind || null,
    owner: r?.owner || null,
    message: extra.message || r?.message || null,
    evidence,
    processes: extra.processes || null,
    ...(extra.details ? { details: extra.details } : {}),
  };
}

/**
 * Prove — or name why it cannot be proved — that `route` (the route of the
 * release `plan` froze, as the stage schedule reads it) applies to the plan's
 * exact Sales line.
 *
 * @param ctx      `{ companyId }` — server-resolved, never from a body
 * @param plan     the planning file, already read inside `ctx.companyId`
 * @param route    `{ state, releaseId, releaseRef, versionNo, sampleStyleId, stages }`
 * @param schedule the saved schedule, if any (its frozen release is checked)
 */
async function prove(ctx, { plan, route, schedule = null }) {
  const companyId = str(ctx?.companyId);
  const basis = plan?.sourceBasis || {};
  const evidence = {
    companyId,
    orderLineRef: str(plan?.orderLineRef),
    planningFileRef: str(plan?.planningFileRef),
    executionPack: basis.executionPackId
      ? { packId: str(basis.executionPackId), versionNo: basis.executionPackVersionNo ?? null } : null,
    requirementVersion: null,
    ieRelease: route?.releaseId
      ? { releaseId: str(route.releaseId), releaseRef: str(route.releaseRef), versionNo: route.versionNo ?? null,
        sampleStyleId: route.sampleStyleId ? str(route.sampleStyleId) : null }
      : (basis.ieReleaseId ? { releaseId: str(basis.ieReleaseId), releaseRef: str(basis.ieReleaseRef),
        versionNo: basis.ieReleaseVersionNo ?? null, sampleStyleId: null } : null),
    routeState: route?.state || null,
  };

  /* ── IE: the release and its route ─────────────────────────────────── */
  if (!route || route.state === "NO_RELEASE") return outcome(STATE.BLOCKED, "RELEASE_MISSING", evidence);
  if (route.state === "UNREADABLE") {
    return outcome(STATE.UNREADABLE, "SOURCE_UNREADABLE", evidence, { details: { source: "IE_PROCESS_ROUTE" } });
  }
  if (route.state !== "DECLARED") return outcome(STATE.BLOCKED, "ROUTE_UNKNOWN", evidence);
  if (str(route.releaseId) !== str(basis.ieReleaseId)
    || (basis.ieReleaseVersionNo != null && route.versionNo !== basis.ieReleaseVersionNo)) {
    return outcome(STATE.BLOCKED, "RELEASE_VERSION_MISMATCH", evidence);
  }
  if (schedule?.ieReleaseId && str(schedule.ieReleaseId) !== str(basis.ieReleaseId)) {
    return outcome(STATE.BLOCKED, "SCHEDULE_RELEASE_MISMATCH", evidence);
  }

  /* ── Merchandising: the frozen pack, and the Sales version it names ─── */
  if (!isId(basis.executionPackId) || !isId(companyId)) {
    return outcome(STATE.BLOCKED, "REQUIREMENT_VERSION_MISSING", evidence);
  }
  let pack;
  let version;
  try {
    pack = await ExecutionPack.findOne({ _id: oid(basis.executionPackId), companyId: oid(companyId) })
      .select({ packVersionNo: 1, contents: 1 }).lean();
    const named = pack?.contents?.salesHandover;
    if (pack && isId(named?.versionId)) {
      version = await SalesHandoverVersion.findOne({ _id: oid(named.versionId), companyId: oid(companyId) })
        .select({ handoverLineRef: 1, versionNo: 1, executionProjection: 1, publication: 1 }).lean();
    }
  } catch {
    return outcome(STATE.UNREADABLE, "SOURCE_UNREADABLE", evidence, { details: { source: "SALES_REQUIREMENT" } });
  }

  /* Not checked here: which IE release the frozen PP-meeting minutes
     reviewed. Merchandising publishes only the minutes' reference, version
     and state to PPC, and PPC reads the meeting through nothing else. */
  const named = pack?.contents?.salesHandover || {};
  if (!pack || pack.packVersionNo !== basis.executionPackVersionNo || !isId(named.versionId) || !version) {
    return outcome(STATE.BLOCKED, "REQUIREMENT_VERSION_MISSING", evidence);
  }
  evidence.requirementVersion = {
    versionId: str(version._id), versionNo: version.versionNo,
    handoverLineRef: str(version.handoverLineRef), publicationState: str(version.publication?.state) || "CURRENT",
  };

  /* ── Sales: the same line, the same version, still standing ─────────── */
  const line = evidence.orderLineRef;
  if (!line
    || str(version.handoverLineRef) !== line
    || str(version.executionProjection?.orderLineRef) !== line
    || (str(named.handoverLineRef) && str(named.handoverLineRef) !== line)
    || (named.versionNo != null && named.versionNo !== version.versionNo)) {
    return outcome(STATE.BLOCKED, "REQUIREMENT_LINE_MISMATCH", evidence);
  }
  if (evidence.requirementVersion.publicationState === "CANCELLED") {
    return outcome(STATE.BLOCKED, "REQUIREMENT_WITHDRAWN", evidence);
  }
  if (evidence.requirementVersion.publicationState === "SUPERSEDED") {
    return outcome(STATE.BLOCKED, "REQUIREMENT_SUPERSEDED", evidence);
  }

  /* ── The garment: Sales' approved style is the release's style ──────── */
  const lineStyle = str(version.executionProjection?.sampleStyleId);
  const releaseStyle = evidence.ieRelease?.sampleStyleId || "";
  if (!lineStyle || !releaseStyle) return outcome(STATE.BLOCKED, "STYLE_UNPROVEN", evidence);
  if (lineStyle !== releaseStyle) return outcome(STATE.BLOCKED, "STYLE_MISMATCH", evidence);

  /* ── The line's special processes against the route ─────────────────── */
  /* Read from THIS version — the one the frozen pack names — and nothing
     newer. The reader passes back only the answers it could prove. */
  const statement = requirements.readStatement(version);
  const processes = compareProcesses(statement, route.stages);
  if (processes.some((p) => p.verdict === "MISMATCH")) {
    return outcome(STATE.BLOCKED, "REQUIREMENT_ROUTE_MISMATCH", evidence, {
      processes, details: { mismatched: processes.filter((p) => p.verdict === "MISMATCH").map((p) => p.process) },
    });
  }
  if (statement?.state === "UNMATCHABLE") {
    return outcome(STATE.BLOCKED, "LINE_PROCESS_UNMATCHABLE", evidence, {
      processes, message: `${statement.detail} PPC cannot plan it.`, details: { unmatchable: statement.unmatchable },
    });
  }
  if (statement?.state !== "STATED" || processes.some((p) => p.verdict !== "MATCH")) {
    return outcome(STATE.BLOCKED, "LINE_REQUIREMENT_NOT_STATED", evidence, {
      processes,
      message: `${statement?.detail || requirements.NOT_STATED_DETAIL} IE's route is per style, so it cannot be accepted as this line's without that statement.`,
      ...(statement?.problems?.length ? { details: { problems: statement.problems } } : {}),
    });
  }
  return outcome(STATE.PROVEN, null, evidence, { processes });
}

module.exports = { prove, compareProcesses, routeSays, STATE, REASONS };

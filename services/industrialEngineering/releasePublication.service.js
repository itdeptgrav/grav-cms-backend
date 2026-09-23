// services/industrialEngineering/releasePublication.service.js
//
// WHAT INDUSTRIAL ENGINEERING PUBLISHES ABOUT A RELEASE, AND NOTHING ELSE.
//
// ── WHY A SECOND READING SURFACE ────────────────────────────────────────────
// The planning department's own acknowledgement service already reads releases:
// that is its inbound QUEUE, and it answers "what have I been handed, and have
// I answered it". This answers a different question, asked from a different
// screen: "for this confirmed order line, is there an issued engineering
// standard at all".
//
// (Named in prose rather than by path on purpose. Four suites assert that NO
// file in this directory mentions the receiving department's service path — a
// deliberately blunt grep over raw source, so that the boundary cannot be
// argued away by a reviewer who is sure their case is the exception. A comment
// that spelled the path would trip it, and rightly: the check is cheap only
// because it is unconditional.)
//
// The queue is organised by release. A planning register is organised by ORDER
// LINE, and most of its rows will have no release — which is exactly the fact
// it has to be able to state. Asking the queue would mean asking "show me
// everything" and joining in the reader, which is the coupling this file
// exists to prevent.
//
// ── WHAT CROSSES, AND WHY IT IS SO LITTLE ───────────────────────────────────
// The reference, the version, the state, when it was issued, and what
// superseded it. Not the bulletin, not the layout, not the capacity figures,
// not the ramp and not the readiness verdict. A planning register prints
// "IEREL-4A91C02D7B v2, accepted"; it does not need 4.5 minutes of garment SAM
// to do that, and a contract that handed it over would be a second, unowned
// copy of the release envelope.
//
// ── AND NO INTEGRITY HASH CROSSES EITHER ────────────────────────────────────
// `aggregateFingerprint` stays on the stored release. The detail read PPC
// already has was written to exclude every fingerprint, digest and hash from
// the envelope — with a test that walks the response recursively and asserts
// it — because they are IE's deduplication mechanism and not an operational
// fact PPC acts on. Publishing one here would quietly reverse that decision
// through a different door.
//
// A reader that needs to detect the release MOVING uses what is published:
// `versionNo`, `state` and `supersededByVersionNo`. IE changes exactly those
// when a release is superseded or withdrawn, so they are sufficient — and they
// are legible to a person reading a screen, which a hash is not.
//
// ── ONE RELEASE CAN SERVE TWO ORDER LINES ───────────────────────────────────
// A release is per STYLE, keyed on `sampleStyleId`. A style may legitimately
// appear on two commercial lines of one order, and both lines then share one
// engineering standard. That is correct and this contract says so plainly by
// keying on the style: a caller asking about two lines of the same style gets
// the same release for both, rather than a duplicate or an error.
"use strict";

const mongoose = require("mongoose");

const IeRelease = require("../../models/CMS_Models/IndustrialEngineering/IeRelease");
const routes = require("./ieProcessRoute.service");
const { fail } = require("../storePurchase/errors");

const str = (v) => String(v ?? "").trim();
const isId = (v) => mongoose.Types.ObjectId.isValid(str(v));
const oid = (v) => new mongoose.Types.ObjectId(str(v));

/** Issued and superseded. Never a withdrawn release, which was never handed over. */
const PUBLISHED_STATES = Object.freeze(["ISSUED", "SUPERSEDED"]);

function assertContext(ctx) {
  if (!ctx?.companyId) {
    throw fail("COMPANY_CONTEXT_UNAVAILABLE", "Your company could not be resolved.");
  }
}

function publishedRelease(doc) {
  return {
    releaseId: String(doc._id),
    releaseRef: str(doc.releaseRef),
    versionNo: doc.versionNo,
    state: str(doc.state),
    sampleStyleId: doc.sampleStyleId ? String(doc.sampleStyleId) : null,
    issuedAt: doc.issuedAt ? new Date(doc.issuedAt).toISOString() : null,
    issuedByName: str(doc.issuedByName),
    supersededByVersionNo: doc.supersededByVersionNo ?? null,
  };
}

/**
 * The current release for each style — the highest version IE has issued.
 *
 * Keyed by `sampleStyleId` because that is the identity an order line carries.
 * A style with no engineering file, or a file that has never been released,
 * simply has no entry: the absence is the answer, and the caller must render it
 * as an absence rather than as a zero.
 */
async function publishCurrentReleasesByStyle(ctx, sampleStyleIds = []) {
  assertContext(ctx);
  const ids = (sampleStyleIds || []).filter(isId).map(oid);
  if (!ids.length) return new Map();

  const docs = await IeRelease.find({
    companyId: oid(ctx.companyId),
    sampleStyleId: { $in: ids },
    state: { $in: PUBLISHED_STATES },
  })
    .sort({ sampleStyleId: 1, versionNo: -1 })
    .select({
      releaseRef: 1, versionNo: 1, state: 1, sampleStyleId: 1,
      issuedAt: 1, issuedByName: 1, supersededByVersionNo: 1,
    })
    .lean();

  const byStyle = new Map();
  for (const d of docs) {
    const key = String(d.sampleStyleId);
    if (byStyle.has(key)) continue;         // the first is the highest version
    byStyle.set(key, publishedRelease(d));
  }
  return byStyle;
}

/**
 * One release by its own id — how a frozen reference is re-read later.
 *
 * A planning record froze `releaseId` at the moment it was created. To ask "has
 * that release moved" it re-reads THAT release, by id, and compares the state
 * and version it now reports with the ones it froze. Null when this company has
 * no such release, which is itself an answer a caller must handle rather than
 * treat as unchanged.
 */
async function publishReleaseById(ctx, releaseId) {
  assertContext(ctx);
  if (!isId(releaseId)) return null;
  const doc = await IeRelease.findOne({
    _id: oid(releaseId),
    companyId: oid(ctx.companyId),
  })
    .select({
      releaseRef: 1, versionNo: 1, state: 1, sampleStyleId: 1,
      issuedAt: 1, issuedByName: 1, supersededByVersionNo: 1,
    })
    .lean();
  return doc ? publishedRelease(doc) : null;
}

/* ══ THE ENGINEERING FIGURES A CAPACITY PLAN NEEDS ═══════════════════════
 *
 * ── WHAT CROSSES ────────────────────────────────────────────────────────────
 * The garment SAM, the efficiency IE planned the style at (the ramp stage's if
 * one was frozen, the steady-state target otherwise), and IE's planned operator
 * count for the layout. With the confirmed quantity those three turn into
 * demand: standard minutes, and the operator-minutes a line must give them.
 *
 * ── WHAT DELIBERATELY DOES NOT ──────────────────────────────────────────────
 * IE's working-time inputs — `availableShiftMinutes`, `breakMinutes`,
 * `shiftsPerDay` — and anything calculated from them. Every capacity standard
 * says, in its own `calendarLinkage`, that those are an explicit IE planning
 * ASSUMPTION resting on no company calendar. A booking made against them would
 * turn a stated guess into a commitment, so the reader is never handed them:
 * `workingTimeAssumption: "EXCLUDED"` says so on the wire, and the working time
 * a booking uses comes from a calendar the planning department publishes.
 *
 * No fingerprint and no digest, for the reason this file's header gives.
 *
 * ── READ BY ID, SO THE FIGURES ARE THE FROZEN RELEASE'S ─────────────────────
 * A plan froze one release by id and version. This reads THAT release and
 * returns its state beside its figures, so a caller can refuse figures from a
 * release that has since been superseded instead of silently using them.
 */
async function publishReleaseEngineering(ctx, releaseId) {
  assertContext(ctx);
  if (!isId(releaseId)) return null;
  const doc = await IeRelease.findOne({ _id: oid(releaseId), companyId: oid(ctx.companyId) })
    .select({
      releaseRef: 1, versionNo: 1, state: 1, sampleStyleId: 1, supersededByVersionNo: 1,
      "source.garmentSamMinutes": 1,
      "source.capacityStandard.inputs.targetEfficiencyPercent": 1,
      "source.capacityStandard.inputs.plannedOperatorCount": 1,
      "source.ramp.targetEfficiencyPercent": 1,
      "source.ramp.stageLabel": 1,
    })
    .lean();
  if (!doc) return null;

  const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== "" ? Number(v) : null);
  const sam = num(doc.source?.garmentSamMinutes);
  const target = num(doc.source?.capacityStandard?.inputs?.targetEfficiencyPercent);
  const ramp = num(doc.source?.ramp?.targetEfficiencyPercent);

  return {
    releaseId: String(doc._id),
    releaseRef: str(doc.releaseRef),
    versionNo: doc.versionNo,
    state: str(doc.state),
    supersededByVersionNo: doc.supersededByVersionNo ?? null,
    garmentSamMinutes: sam !== null && sam > 0 ? sam : null,
    targetEfficiencyPercent: target !== null && target > 0 ? target : null,
    rampEfficiencyPercent: ramp !== null && ramp > 0 ? ramp : null,
    rampStageLabel: str(doc.source?.ramp?.stageLabel),
    plannedOperatorCount: num(doc.source?.capacityStandard?.inputs?.plannedOperatorCount),
    workingTimeAssumption: "EXCLUDED",
  };
}

/* ══ THE APPROVED PROCESS ROUTE A MULTI-STAGE PLAN NEEDS ════════════════
 *
 * Which production processes the released style passes through, in what
 * dependency order, and which optional ones IE approved as NOT applicable —
 * frozen into the release from its approved bulletin version.
 *
 * ── UNKNOWN IS AN ANSWER, NOT AN EMPTY LIST ──────────────────────────────────
 * A release issued before routes existed, or from a version that declared
 * none, publishes `routeState: "UNKNOWN"` with `stages: null`. It is never
 * reconstructed from operation names or machine codes, and never presented as
 * "no stages". A planner must show it as a blocker, not plan around it.
 *
 * ── READ BY ID, SO THE ROUTE IS THE FROZEN RELEASE'S ────────────────────────
 * A plan freezes one release. A later route revision is a later release with
 * its own copy; this one keeps the route it was issued with, and says whether
 * it has since been superseded so the caller can decide what to do about it.
 *
 * `stageId` is the identity a plan keys on — stable across route revisions for
 * a stage that survives them. A process may appear more than once (each with a
 * distinct label), so neither `process` nor `label` is a key. Parallel stages
 * are required stages with no predecessor path between them.
 *
 * No fingerprint and no digest, for the reason this file's header gives.
 */
async function publishReleaseProcessRoute(ctx, releaseId) {
  assertContext(ctx);
  if (!isId(releaseId)) return null;
  const doc = await IeRelease.findOne({ _id: oid(releaseId), companyId: oid(ctx.companyId) })
    .select({
      releaseRef: 1, versionNo: 1, state: 1, sampleStyleId: 1, supersededByVersionNo: 1,
      "source.bulletinVersionId": 1, "source.bulletinVersionNo": 1, "source.processRoute": 1,
    })
    .lean();
  if (!doc) return null;

  const stored = Array.isArray(doc.source?.processRoute?.stages) ? doc.source.processRoute.stages : [];
  const stages = stored.map((st) => ({
    stageId: str(st.stageId),
    sequence: st.sequence,
    process: str(st.process),
    label: str(st.label),
    applicability: str(st.applicability),
    predecessorStageIds: (st.predecessorStageIds || []).map(str),
    /* The approved technical standard for this stage, exactly as this release
       froze it — or null, which is a real answer and not a zero. Read-only on
       the far side of this contract: Planning calculates from it and cannot
       write it back. */
    technicalStandard: routes.publishStandard(st.technicalStandard),
  }));

  return {
    releaseId: String(doc._id),
    releaseRef: str(doc.releaseRef),
    versionNo: doc.versionNo,
    state: str(doc.state),
    supersededByVersionNo: doc.supersededByVersionNo ?? null,
    sampleStyleId: doc.sampleStyleId ? String(doc.sampleStyleId) : null,
    bulletinVersionId: doc.source?.bulletinVersionId ? String(doc.source.bulletinVersionId) : null,
    bulletinVersionNo: doc.source?.bulletinVersionNo ?? null,
    routeState: stages.length ? "DECLARED" : "UNKNOWN",
    stages: stages.length ? stages : null,
  };
}

module.exports = {
  PUBLISHED_STATES,
  publishCurrentReleasesByStyle,
  publishReleaseById,
  publishReleaseEngineering,
  publishReleaseProcessRoute,
};

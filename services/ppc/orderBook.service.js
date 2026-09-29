// services/ppc/orderBook.service.js
//
// THE PPC ORDER BOOK — which confirmed order lines are entering planning, what
// authoritative inputs exist, and which planning file owns each line.
//
// ── THE REGISTER IS A JOIN OVER PUBLISHED CONTRACTS ─────────────────────────
// Not a copy, not an outbox, and not a query against another application's
// collections. Merchandising publishes its order lines, packs, minutes and
// department-status context; IE publishes its releases; PPC reads its own
// receipts and its own planning files. This service joins those six answers on
// the PERMANENT order-line reference and computes nothing else.
//
// There is therefore nothing to reconcile and nothing to go stale: the register
// is recomputed on every read, so a pack accepted a second ago is visible a
// second later, and a planning file nobody created is simply absent.
//
// ── A FAILED READ IS `UNREADABLE`, NEVER `MISSING` ──────────────────────────
// Each upstream read is wrapped. When one fails, that input alone becomes
// `UNREADABLE` — "Couldn’t check" — and the row still renders with everything
// that DID read. The alternative is a 500 for the whole register because one
// department's collection was briefly unavailable, or, far worse, a row that
// says "Not received" because the read threw.
//
// This matters more than it looks. `MISSING` is a statement that somebody has
// not done their work; a planner acts on it by chasing them. Producing it from
// a failed read means chasing a department that had in fact delivered.
//
// ── AND EVERY COUNT OPENS ITS OWN ROWS ──────────────────────────────────────
// The summary counts are computed by classifying rows through exactly the same
// code path the register uses — `classifyRow` below, called by both. A count
// and the filtered list behind it cannot disagree, because there is only one
// classification and no second query that could drift from the first.
"use strict";

const mongoose = require("mongoose");

const merch = require("../merchandising/planningPublication.service");
const ie = require("../industrialEngineering/releasePublication.service");
const {
  DownstreamHandoverReceipt,
} = require("../../models/CMS_Models/PPC/DownstreamHandoverReceipt");
const { IeReleaseReceipt } = require("../../models/CMS_Models/PPC/IeReleaseReceipt");
const {
  PpcPlanningFile, ACTIVE_STATES,
} = require("../../models/CMS_Models/PPC/PpcPlanningFile");
const {
  INPUT_STATE, INPUT_WORDS, REQUIRED_INPUTS, CONTEXT_INPUTS,
  eligibility, readiness, VIEW, VIEWS, viewOf,
} = require("./planningReadiness.contract");
const { AVAILABILITY } = require("../merchandising/departmentStatus.contract");
const { businessDateFromInstant } = require("./businessDate");
const { fail } = require("../storePurchase/errors");

const str = (v) => String(v ?? "").trim();
const oid = (v) => new mongoose.Types.ObjectId(str(v));

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

/** The departments whose status PPC shows as material context. */
const MATERIAL_DEPARTMENTS = Object.freeze(["STORE", "SUPPLY_CHAIN"]);

function assertContext(ctx) {
  if (!ctx?.companyId) {
    throw fail("COMPANY_CONTEXT_UNAVAILABLE", "Your company could not be resolved.");
  }
}

/**
 * Run one upstream read and convert a failure into an absence of data plus a
 * recorded fault — never into a thrown request and never into a false zero.
 *
 * The fault list travels to the caller so the screen can say WHICH source could
 * not be reached, rather than showing five cells of "Couldn’t check" and
 * leaving a planner to guess whether the whole backend is down.
 */
async function guarded(faults, source, read, fallback) {
  try {
    return await read();
  } catch (err) {
    faults.push({
      source,
      code: str(err?.code) || "SOURCE_READ_FAILED",
      /* The message is for an operator reading a log, not for the planner: the
         screen shows "Couldn’t check" and offers a retry. */
      detail: str(err?.message).slice(0, 300),
    });
    return fallback;
  }
}

/* ══ ONE ROW'S INPUT VERDICTS ═════════════════════════════════════════════ */

/**
 * The Execution Pack verdict.
 *
 * SATISFIED needs two facts and both are somebody's decision: Merchandising
 * SUBMITTED the current pack, and PPC ACCEPTED that exact version. A pack
 * accepted at version 3 while version 4 is now current is not satisfied — it is
 * `PENDING`, because the current pack is awaiting PPC's answer.
 *
 * "That exact version" is checked on BOTH identities PPC's receipt carries: the
 * pack document it was written against and the version number it recorded. A
 * receipt that names this pack but a different version is not an acceptance of
 * anything anybody can point at, so it is `PENDING` with the reason stated —
 * never quietly satisfied.
 */
function packVerdict({ unreadable, pack, receipt }) {
  if (unreadable) return { state: INPUT_STATE.UNREADABLE };
  if (!pack) return { state: INPUT_STATE.MISSING };

  const base = {
    packId: pack.packId,
    versionNo: pack.packVersionNo,
    sourceState: pack.state,
    allGatesPassed: pack.allGatesPassed,
    receiptState: receipt ? str(receipt.state) : null,
    receiptVersionNo: receipt ? receipt.packVersionNo : null,
  };

  if (pack.state === "WITHDRAWN" || pack.state === "CANCELLED") {
    return { ...base, state: INPUT_STATE.MISSING };
  }
  if (pack.state === "SUPERSEDED") return { ...base, state: INPUT_STATE.MOVED };

  /* The receipt has to be for THIS version. An acceptance of an older pack is
     not an acceptance of the pack now in front of PPC. */
  if (receipt && (String(receipt.packId) !== String(pack.packId)
    || receipt.packVersionNo !== pack.packVersionNo)) {
    return { ...base, state: INPUT_STATE.PENDING, reason: "RECEIPT_VERSION_MISMATCH" };
  }
  const acceptedThisVersion = receipt && str(receipt.state) === "ACCEPTED";

  if (acceptedThisVersion) return { ...base, state: INPUT_STATE.SATISFIED };
  return { ...base, state: INPUT_STATE.PENDING };
}

/**
 * The engineering-release verdict.
 *
 * A line whose style has no engineering file at all has no release, and that is
 * `MISSING` — the honest answer, not an error. A release issued but not yet
 * answered by PPC is `PENDING`: IE has done its part and PPC has not.
 */
function releaseVerdict({ unreadable, release, receipt, sampleStyleId }) {
  if (unreadable) return { state: INPUT_STATE.UNREADABLE };
  /* No stable style identity means the join cannot even be attempted. Reported
     as missing with the reason, rather than silently as "no release". */
  if (!sampleStyleId) {
    return { state: INPUT_STATE.MISSING, reason: "NO_STABLE_STYLE_IDENTITY" };
  }
  if (!release) return { state: INPUT_STATE.MISSING };

  const base = {
    releaseId: release.releaseId,
    releaseRef: release.releaseRef,
    versionNo: release.versionNo,
    sourceState: release.state,
    receiptState: receipt ? str(receipt.state) : null,
    receiptVersionNo: receipt ? receipt.releaseVersionNo : null,
  };

  if (release.state === "SUPERSEDED") return { ...base, state: INPUT_STATE.MOVED };

  /* The receipt must be for this release document AND record this release's
     own reference and version — the same exactness as the pack. */
  if (receipt && (String(receipt.ieReleaseId) !== String(release.releaseId)
    || str(receipt.releaseRef) !== str(release.releaseRef)
    || receipt.releaseVersionNo !== release.versionNo)) {
    return { ...base, state: INPUT_STATE.PENDING, reason: "RECEIPT_VERSION_MISMATCH" };
  }
  const acceptedThisVersion = receipt && str(receipt.state) === "ACCEPTED";

  if (acceptedThisVersion) return { ...base, state: INPUT_STATE.SATISFIED };
  return { ...base, state: INPUT_STATE.PENDING };
}

/**
 * The minutes verdict.
 *
 * Issued minutes need no PPC receipt: minutes are a record of a meeting PPC
 * attended, not a handover PPC answers. Superseded minutes have moved.
 */
/**
 * @param candidate the release a plan created now WOULD freeze, so the gate
 *   asks the same question of a plan being made that `sourceHealth` asks of
 *   one already frozen.
 */
function ppmVerdict({ unreadable, ppm, candidate = null }) {
  if (unreadable) return { state: INPUT_STATE.UNREADABLE };
  if (!ppm) return { state: INPUT_STATE.MISSING };
  const base = {
    meetingId: ppm.meetingId,
    versionNo: ppm.versionNo,
    sourceState: ppm.state,
    issuedAt: ppm.issuedAt,
  };
  if (ppm.state === "SUPERSEDED") return { ...base, state: INPUT_STATE.MOVED };
  if (ppm.state !== "ISSUED") return { ...base, state: INPUT_STATE.PENDING };

  /* ── AND DID THIS MEETING REVIEW THE ENGINEERING A PLAN WOULD FREEZE? ──
     A NEW plan must not adopt evidence that says nothing, or says something
     else, as proof — so the answer is part of whether the minutes satisfy
     PPC at all, not a footnote on a row that already reads "Ready".

     Legacy evidence is refused here too, and only here. A plan made now must
     not adopt, as proof, a record that could never carry the answer — and the
     remedy is real and in the planner's hands: Merchandising re-issues the
     minutes under the current contract with the release that was reviewed.
     A plan already frozen against those same minutes keeps working; see
     `REVIEWED_RELEASE_BLOCKING_AT_CREATION` above for why the two questions
     get different answers. */
  const rr = reviewedReleaseVerdict({
    ppm,
    frozenReleaseId: candidate?.releaseId ? str(candidate.releaseId) : "",
    frozenVersionNo: candidate?.versionNo ?? null,
  });
  const row = { ...base, reviewedRelease: rr.verdict.state, evidenceContractVersion: rr.verdict.contractVersion };
  if (REVIEWED_RELEASE_BLOCKING_AT_CREATION.includes(rr.verdict.state)) {
    /* Present, and not in the state PPC needs — which is what PENDING is for,
       and which `readiness()` already counts as proved-blocking. */
    return {
      ...row,
      state: INPUT_STATE.PENDING,
      reason: CREATION_REASON[rr.verdict.state] || rr.verdict.state,
    };
  }
  return { ...row, state: INPUT_STATE.SATISFIED };
}

/**
 * Material context — SHOWN, and never a gate.
 *
 * Carries the four-state availability vocabulary through unchanged, so "not
 * reported" stays distinguishable from "reported as nothing". It produces no
 * INPUT_STATE at all, which is the structural reason it cannot accidentally
 * become a requirement: `readiness()` consults only the required keys.
 */
function materialContext({ unreadable, rows }) {
  if (unreadable) {
    return { availability: AVAILABILITY.UNKNOWN, unreadable: true, statements: [] };
  }
  const statements = (rows || [])
    .filter((r) => MATERIAL_DEPARTMENTS.includes(r.department))
    .map((r) => ({
      department: r.department,
      statusCode: r.statusCode,
      statusLabel: r.statusLabel,
      availability: r.availability,
      observedAt: r.sourceObservedAt,
      sourceApp: r.sourceApp,
    }));
  return {
    unreadable: false,
    statements,
    /* No statement is NOT "nothing to report" — it is "nobody reported". */
    availability: statements.length ? statements[0].availability : AVAILABILITY.UNKNOWN,
  };
}

/* ══ SOURCE MOVEMENT AGAINST A FROZEN BASIS ═══════════════════════════════ */

/**
 * Has anything this plan was made from moved since it was made?
 *
 * Compared by VERSION and STATE, which is what the publication contracts expose
 * — see `releasePublication.service.js` for why no integrity hash crosses to
 * PPC. A version change, a supersession or a withdrawal are all movements a
 * planner must see; nothing else is.
 *
 * Returns the movements, never a rewrite. The frozen basis is immutable at the
 * schema level, so this function could not rewrite it if it tried.
 */
/* ══ DID THE MEETING REVIEW THIS EXACT ENGINEERING RELEASE? ═══════════════
 *
 * Two applications each name an IE release: Merchandising's minutes record
 * what was on the table, PPC's plan records what it is planning against.
 * Agreement is the same RECORD at the same VERSION — both fields, both ways.
 * A version alone is not an identity, an id alone is not either, and
 * agreement is never inferred from the style, the style code, the release
 * name, the display text, the operation names, or from which release happens
 * to be newest.
 *
 * ── THREE KINDS OF SILENCE, AND ONLY ONE OF THEM IS A STATEMENT ───────────
 * LEGACY. Minutes captured before the snapshot recorded which release was
 * reviewed. They cannot answer the question. Reported as
 * `LEGACY_EVIDENCE_UNAVAILABLE` and never as a movement: making it one would
 * retroactively fail every plan frozen against minutes issued before the
 * contract existed, and those records cannot be rewritten to agree — nor
 * should they be. A plan already frozen on them keeps working and shows the
 * gap.
 *
 * NOT REVIEWED. Minutes captured UNDER the current contract, which looked and
 * found no release. That is a positive statement, and it blocks.
 *
 * MALFORMED. Minutes captured under the current contract whose release row
 * names no record or no version. Present and unusable is a proven defect in
 * the evidence, not a failed read, so it blocks too.
 *
 * Which of the three it is comes from the contract version the MEETING
 * stamped on its own snapshot — never from a date, never from the null alone.
 */
const REVIEWED_RELEASE = Object.freeze({
  AGREED: "AGREED",
  LEGACY_EVIDENCE_UNAVAILABLE: "LEGACY_EVIDENCE_UNAVAILABLE",
  PPM_RELEASE_NOT_REVIEWED: "PPM_RELEASE_NOT_REVIEWED",
  PPM_RELEASE_UNREADABLE: "PPM_RELEASE_UNREADABLE",
  PPM_RELEASE_ID_MISMATCH: "PPM_RELEASE_ID_MISMATCH",
  PPM_RELEASE_VERSION_MISMATCH: "PPM_RELEASE_VERSION_MISMATCH",
  /* No minutes to ask, no release to compare, or the read failed. */
  NO_MINUTES: "NO_MINUTES",
  NOT_APPLICABLE: "NOT_APPLICABLE",
  UNDETERMINED: "UNDETERMINED",
});

/* ── ONE EVALUATION, TWO POLICIES ──────────────────────────────────────────
 * The verdict is a FACT about the evidence and is computed once. What to do
 * about it depends on which question is being asked, and the two answers are
 * deliberately different:
 *
 *   MAKING A NEW PLAN is a decision taken now, with today's evidence. It may
 *   not be taken on evidence that cannot answer the question — the remedy is
 *   in the planner's hands, and it is not a workaround: Merchandising
 *   re-issues the minutes under the current contract, recording which release
 *   was reviewed, and the plan is then made against evidence that says so.
 *
 *   READING A PLAN ALREADY FROZEN is a different question. That decision was
 *   taken when the evidence could not have said more, the records are frozen
 *   and are not rewritten, and calling it "moved" now would be this system
 *   failing its own history for a gap nobody can close in the past. It stays
 *   readable, and the gap stays visible.
 *
 * So legacy evidence appears in the creation list below and NOT in the
 * movement list. Everything the current contract actually stated — nothing
 * reviewed, malformed, a different record, a different version — is in both.
 */
/* What the current contract actually STATED, and therefore what reports a
   movement — pushed by the evaluator itself, on the branch that decides each
   one, so this list can never drift out of step with what it names. */
const REVIEWED_RELEASE_BLOCKING = Object.freeze([
  REVIEWED_RELEASE.PPM_RELEASE_NOT_REVIEWED,
  REVIEWED_RELEASE.PPM_RELEASE_UNREADABLE,
  REVIEWED_RELEASE.PPM_RELEASE_ID_MISMATCH,
  REVIEWED_RELEASE.PPM_RELEASE_VERSION_MISMATCH,
]);

/** Additionally refused when a NEW plan or successor generation is made. */
const REVIEWED_RELEASE_BLOCKING_AT_CREATION = Object.freeze([
  ...REVIEWED_RELEASE_BLOCKING,
  REVIEWED_RELEASE.LEGACY_EVIDENCE_UNAVAILABLE,
]);

/* The reason a creation refusal gives for it. The verdict names the state of
   the EVIDENCE; this names the POLICY that refused, so a planner is told what
   to do rather than what was missing. */
const CREATION_REASON = Object.freeze({
  [REVIEWED_RELEASE.LEGACY_EVIDENCE_UNAVAILABLE]: "PPM_RELEASE_LEGACY_EVIDENCE",
});

/**
 * One evaluation, used by BOTH the readiness gate that decides whether a plan
 * may be created and the health check that reports on one already frozen. Two
 * implementations would drift, and the day they did, a plan could be created
 * against evidence its own health screen called broken.
 */
function reviewedReleaseVerdict({ ppm, frozenReleaseId, frozenVersionNo }) {
  const none = (state) => ({
    verdict: { state, frozen: null, reviewed: null, contractVersion: null },
    movement: null, undetermined: false,
  });
  if (!frozenReleaseId) return none(REVIEWED_RELEASE.NOT_APPLICABLE);
  if (ppm === undefined) {
    return { ...none(REVIEWED_RELEASE.UNDETERMINED), undetermined: true };
  }

  const contract = ppm?.evidenceContract || { version: null, capturesReviewedRelease: false };
  const reviewed = ppm?.reviewedIeRelease ?? null;
  const frozen = { releaseId: frozenReleaseId, versionNo: frozenVersionNo };
  const out = (state, movement = null) => ({
    verdict: {
      state,
      frozen,
      reviewed: reviewed
        ? { releaseId: reviewed.releaseId || null, versionNo: reviewed.versionNo ?? null }
        : null,
      contractVersion: contract.version,
    },
    movement,
    undetermined: false,
  });
  const mismatch = (kind, from, to) => out(kind, {
    key: "ppmReviewedRelease", label: "Engineering release reviewed at the meeting",
    from, to, kind,
  });

  if (!ppm) return out(REVIEWED_RELEASE.NO_MINUTES);
  if (!contract.capturesReviewedRelease) {
    /* The record predates the question. It is not agreement and not a fault. */
    return out(REVIEWED_RELEASE.LEGACY_EVIDENCE_UNAVAILABLE);
  }
  if (!reviewed) return mismatch(REVIEWED_RELEASE.PPM_RELEASE_NOT_REVIEWED, frozenReleaseId, null);
  if (!reviewed.releaseId || reviewed.versionNo === null || reviewed.versionNo === undefined) {
    return mismatch(REVIEWED_RELEASE.PPM_RELEASE_UNREADABLE,
      frozenReleaseId, reviewed.releaseId || null);
  }
  if (str(reviewed.releaseId) !== frozenReleaseId) {
    /* Only the ids are reported: the other release may be another style's,
       and its reference is not this reader's to be told. */
    return mismatch(REVIEWED_RELEASE.PPM_RELEASE_ID_MISMATCH, frozenReleaseId, str(reviewed.releaseId));
  }
  if (frozenVersionNo !== null && frozenVersionNo !== undefined
    && reviewed.versionNo !== frozenVersionNo) {
    return mismatch(REVIEWED_RELEASE.PPM_RELEASE_VERSION_MISMATCH, frozenVersionNo, reviewed.versionNo);
  }
  return out(REVIEWED_RELEASE.AGREED);
}

function sourceMovement(basis, live) {
  if (!basis) return { moved: false, movements: [], undetermined: false };
  const movements = [];
  let undetermined = false;

  const compare = (key, label, frozenVersion, frozenState, now, nowVersionKey) => {
    if (now === undefined) { undetermined = true; return; }   // could not read
    if (now === null) {
      if (frozenVersion !== null && frozenVersion !== undefined) {
        movements.push({ key, label, from: frozenVersion, to: null, kind: "DISAPPEARED" });
      }
      return;
    }
    const nowVersion = now[nowVersionKey] ?? null;
    if (frozenVersion !== null && nowVersion !== null && nowVersion !== frozenVersion) {
      movements.push({ key, label, from: frozenVersion, to: nowVersion, kind: "VERSION_CHANGED" });
      return;
    }
    const nowState = str(now.state);
    if (frozenState && nowState && nowState !== str(frozenState)) {
      movements.push({ key, label, from: frozenState, to: nowState, kind: "STATE_CHANGED" });
    }
  };

  compare("executionPack", "Merchandising Execution Pack",
    basis.executionPackVersionNo, basis.executionPackState, live.pack, "packVersionNo");
  compare("ieRelease", "Engineering release",
    basis.ieReleaseVersionNo, basis.ieReleaseState, live.release, "versionNo");
  compare("ppmMinutes", "Pre-Production Meeting minutes",
    basis.ppmVersionNo, basis.ppmState, live.ppm, "versionNo");

  /* ── DID THE MEETING REVIEW THE RELEASE THIS PLAN FROZE? ────────────── */
  const rr = reviewedReleaseVerdict({
    ppm: live.ppm,
    frozenReleaseId: basis.ieReleaseId ? str(basis.ieReleaseId) : "",
    frozenVersionNo: basis.ieReleaseVersionNo ?? null,
  });
  const reviewedRelease = rr.verdict;
  if (rr.undetermined) undetermined = true;
  if (rr.movement) movements.push(rr.movement);

  /* The confirmed commitment itself can move — a re-confirmed quantity is a
     different order from the one that was planned. */
  if (live.line !== undefined && live.line !== null) {
    const nowQty = live.line.confirmedQuantity;
    if (Number.isFinite(basis.confirmedQuantity) && Number.isFinite(nowQty)
      && nowQty !== basis.confirmedQuantity) {
      movements.push({
        key: "confirmedQuantity", label: "Confirmed quantity",
        from: basis.confirmedQuantity, to: nowQty, kind: "VERSION_CHANGED",
      });
    }
  } else if (live.line === undefined) {
    undetermined = true;
  }

  return { moved: movements.length > 0, movements, undetermined, reviewedRelease };
}

/* ══ CLASSIFYING ONE ROW — THE SINGLE CODE PATH ═══════════════════════════ */

/**
 * One order-book row, from the published facts and PPC's own records.
 *
 * Both the register and the summary call this, which is what makes every count
 * open exactly the rows behind it.
 */
function classifyRow({ line, pack, packReceipt, release, ieReceipt, ppm, statusRows, planningFile, unreadable }) {
  const elig = eligibility(line);

  const inputs = {
    orderLine: elig.eligible
      ? { state: INPUT_STATE.SATISFIED, orderLineRef: line.orderLineRef }
      : { state: INPUT_STATE.MISSING, reason: "NO_STABLE_IDENTITY", missing: elig.missingIdentity },
    executionPack: packVerdict({ unreadable: unreadable.pack, pack, receipt: packReceipt }),
    ieRelease: releaseVerdict({
      unreadable: unreadable.release, release, receipt: ieReceipt,
      sampleStyleId: line.sampleStyleId,
    }),
    /* The release this line's plan would freeze, so the minutes are judged
       against the same engineering the plan would adopt. */
    ppmMinutes: ppmVerdict({
      unreadable: unreadable.ppm, ppm,
      candidate: release ? { releaseId: release.releaseId, versionNo: release.versionNo } : null,
    }),
  };

  const material = materialContext({ unreadable: unreadable.status, rows: statusRows });

  const states = Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, v.state]));
  const ready = readiness(states);

  /* Movement is only meaningful for a line that HAS a plan — there is no frozen
     basis to compare against otherwise. */
  const movement = planningFile
    ? sourceMovement(planningFile.sourceBasis, {
      pack: unreadable.pack ? undefined : (pack || null),
      release: unreadable.release ? undefined : (release || null),
      ppm: unreadable.ppm ? undefined : (ppm || null),
      line,
    })
    : { moved: false, movements: [], undetermined: false };

  const planningState = planningFile ? str(planningFile.state) : null;
  const ownsLine = planningState ? ACTIVE_STATES.includes(planningState) : false;

  return {
    /* ── IDENTITY ────────────────────────────────────────────────────── */
    orderRef: line.orderRef,
    orderLineRef: line.orderLineRef,
    executionFileId: line.executionFileId,
    executionFileRef: line.executionFileRef,
    sampleStyleId: line.sampleStyleId,

    /* ── WHAT A REGISTER PRINTS ──────────────────────────────────────── */
    buyer: line.buyerDisplayLabel,
    brand: line.brandDisplayLabel,
    styleRef: line.styleRef,
    productName: line.productName,
    colourways: line.colourways,
    confirmedQuantity: line.confirmedQuantity,
    /* A factory calendar day, so no browser timezone can print the day before. */
    earliestDeliveryDate: businessDateFromInstant(line.earliestDeliveryDate),
    deliveryCount: line.deliveryCount,
    /* "Where known" — an empty list is an empty list, not a guess. */
    factoryRefs: line.nominatedFactoryRefs?.length
      ? line.nominatedFactoryRefs
      : (line.factoryRef ? [line.factoryRef] : []),

    /* ── THE AUTHORITATIVE INPUTS ────────────────────────────────────── */
    inputs,
    inputWords: Object.fromEntries(
      Object.entries(states).map(([k, v]) => [k, INPUT_WORDS[v] || v]),
    ),
    material,

    /* ── READINESS, KEPT SEPARATE FROM ELIGIBILITY ───────────────────── */
    eligible: elig.eligible,
    readyToPlan: ready.ready,
    blocked: ready.blocked,
    undetermined: ready.undetermined,
    unsatisfiedInputs: ready.unsatisfied,
    unreadableInputs: ready.unreadable,

    /* ── WHICH PLANNING FILE OWNS THE LINE ───────────────────────────── */
    planningFileId: planningFile ? String(planningFile._id) : null,
    planningFileRef: planningFile ? str(planningFile.planningFileRef) : null,
    planningState,
    planningOwnsLine: ownsLine,
    planningGeneration: planningFile ? planningFile.generation : null,
    ppcOwner: planningFile?.planning?.owner?.name
      ? str(planningFile.planning.owner.name) : null,
    priority: planningFile?.planning?.priority || null,
    holdReason: planningFile?.holdReason || null,

    /* ── THE SOURCE MOVEMENT WARNING ─────────────────────────────────── */
    sourceMoved: movement.moved,
    sourceMovements: movement.movements,
    sourceMovementUndetermined: movement.undetermined,

    view: viewOf({
      planningState: ownsLine ? planningState : null,
      ready: ready.ready,
      undetermined: ready.undetermined,
    }),
  };
}

/* ══ THE REGISTER ═════════════════════════════════════════════════════════ */

/**
 * Gather every published fact for one page of order lines, then classify.
 *
 * The upstream reads are batched by page rather than per row — four queries for
 * twenty-five rows, not a hundred — and each is guarded independently so one
 * failing source degrades one column instead of the request.
 */
async function gather(ctx, lines, faults) {
  const fileIds = lines.map((l) => l.executionFileId).filter(Boolean);
  const styleIds = [...new Set(lines.map((l) => l.sampleStyleId).filter(Boolean))];
  const lineRefs = lines.map((l) => l.orderLineRef).filter(Boolean);

  const unreadable = { pack: false, release: false, ppm: false, status: false, planning: false };

  const packs = await guarded(faults, "MERCHANDISING_EXECUTION_PACK",
    () => merch.publishCurrentExecutionPacks(ctx, fileIds), null);
  if (packs === null) unreadable.pack = true;

  const ppms = await guarded(faults, "MERCHANDISING_PPM",
    () => merch.publishIssuedMeetingMinutes(ctx, fileIds), null);
  if (ppms === null) unreadable.ppm = true;

  const releases = await guarded(faults, "IE_RELEASE",
    () => ie.publishCurrentReleasesByStyle(ctx, styleIds), null);
  if (releases === null) unreadable.release = true;

  const statuses = await guarded(faults, "DEPARTMENT_STATUS",
    () => merch.publishDepartmentStatusContext(ctx, fileIds, MATERIAL_DEPARTMENTS), null);
  if (statuses === null) unreadable.status = true;

  /* PPC's own receipts. A failure here is still `UNREADABLE` on the affected
     input, because "PPC has not accepted" and "we could not read PPC's own
     receipts" are different facts too.

     Read by the CURRENT pack's own id — one receipt per pack document, unique
     in PPC's database — rather than "the newest receipt on the file", which
     would happily pair version 4's pack with version 3's acceptance. */
  const packReceipts = await guarded(faults, "PPC_PACK_RECEIPT", async () => {
    const packIds = [...(packs?.values() || [])].map((p) => p.packId).filter(Boolean);
    if (!packIds.length) return new Map();
    const rows = await DownstreamHandoverReceipt.find({
      companyId: oid(ctx.companyId), packId: { $in: packIds.map(oid) },
    }).lean();
    return new Map(rows.map((r) => [String(r.packId), r]));
  }, null);
  if (packReceipts === null) unreadable.pack = true;

  const ieReceipts = await guarded(faults, "PPC_IE_RECEIPT", async () => {
    const releaseIds = [...(releases?.values() || [])].map((r) => r.releaseId).filter(Boolean);
    if (!releaseIds.length) return new Map();
    const rows = await IeReleaseReceipt.find({
      companyId: oid(ctx.companyId), ieReleaseId: { $in: releaseIds.map(oid) },
    }).lean();
    return new Map(rows.map((r) => [String(r.ieReleaseId), r]));
  }, null);
  if (ieReceipts === null) unreadable.release = true;

  const planningFiles = await guarded(faults, "PPC_PLANNING_FILE", async () => {
    const rows = await PpcPlanningFile.find({
      companyId: oid(ctx.companyId),
      orderLineRef: { $in: lineRefs },
      state: { $in: ACTIVE_STATES },
    }).lean();
    return new Map(rows.map((r) => [str(r.orderLineRef), r]));
  }, null);
  if (planningFiles === null) unreadable.planning = true;

  /* ── WHICH OF PPC'S OWN RECEIPTS AUTHORISE EACH READY LINE ─────────────
     PPC owns these receipts, so it may name them — but only to itself. They
     travel in a map BESIDE the rows, never inside a row: a row is what the
     register serves, and a receipt id is provenance, not something a planner
     reads. A line gets an entry only when both inputs are SATISFIED, i.e. only
     when the exact receipt for the exact current version was found. */
  const provenance = new Map();
  const rows = lines.map((line) => {
    const pack = packs?.get(line.executionFileId) || null;
    const packReceipt = pack ? (packReceipts?.get(pack.packId) || null) : null;
    const release = line.sampleStyleId ? (releases?.get(line.sampleStyleId) || null) : null;
    const ieReceipt = release ? (ieReceipts?.get(release.releaseId) || null) : null;
    const row = classifyRow({
      line, pack, packReceipt, release, ieReceipt,
      ppm: ppms?.get(line.executionFileId) || null,
      statusRows: statuses?.get(line.executionFileId) || [],
      planningFile: planningFiles?.get(line.orderLineRef) || null,
      unreadable,
    });
    if (row.inputs.executionPack.state === INPUT_STATE.SATISFIED
      && row.inputs.ieRelease.state === INPUT_STATE.SATISFIED) {
      provenance.set(line.orderLineRef, {
        packId: String(pack.packId),
        packVersionNo: pack.packVersionNo,
        packReceiptId: String(packReceipt._id),
        packReceiptVersionNo: packReceipt.packVersionNo,
        ieReleaseId: String(release.releaseId),
        ieReleaseRef: str(release.releaseRef),
        ieReleaseVersionNo: release.versionNo,
        ieReceiptId: String(ieReceipt._id),
        ieReceiptVersionNo: ieReceipt.releaseVersionNo,
      });
    }
    return row;
  });

  return { unreadable, rows, provenance };
}

/**
 * The register — one page of rows, filtered server-side.
 *
 * Filtering happens AFTER classification and BEFORE the page is returned, which
 * is the only order that can be correct: a row's view depends on facts from six
 * sources, so it cannot be expressed as a Mongo predicate on one collection.
 *
 * The cursor therefore paginates the underlying ORDER LINES and the view filter
 * is applied to the page — so a caller walking `nextCursor` to exhaustion sees
 * every row in the view exactly once, which is the guarantee that matters.
 */
async function register(ctx, {
  view = VIEW.ALL, cursor = "", limit = DEFAULT_LIMIT, search = "",
} = {}) {
  assertContext(ctx);
  const wanted = str(view) || VIEW.ALL;
  if (!VIEWS.includes(wanted)) {
    throw fail("PPC_ORDER_BOOK_VIEW_UNKNOWN",
      "That is not one of the order book's views.", { view: wanted, allowed: [...VIEWS] });
  }
  const rawLimit = Number(limit);
  if (limit !== undefined && limit !== "" && (!Number.isFinite(rawLimit) || rawLimit < 1)) {
    throw fail("PPC_ORDER_BOOK_LIMIT_INVALID",
      "A page size has to be a positive whole number.", { limit });
  }
  const size = Math.min(Math.max(Math.trunc(rawLimit) || DEFAULT_LIMIT, 1), MAX_LIMIT);

  const faults = [];
  const published = await guarded(faults, "MERCHANDISING_ORDER_LINE",
    () => merch.publishConfirmedOrderLines(ctx, { cursor, limit: size, search }), null);

  /* The order lines are the register's SPINE. If that read fails there is no
     row to degrade — the honest answer is that the register could not be read,
     and the screen shows its failed state with a retry. */
  if (published === null) {
    throw fail("PPC_ORDER_BOOK_UNAVAILABLE",
      "The confirmed order lines could not be read, so the order book cannot be shown. Nothing is missing — this is a failed read.",
      { faults });
  }

  const { rows } = await gather(ctx, published.lines, faults);
  const visible = wanted === VIEW.ALL ? rows : rows.filter((r) => r.view === wanted);

  return {
    view: wanted,
    rows: visible,
    limit: size,
    maxLimit: MAX_LIMIT,
    nextCursor: published.nextCursor,
    hasMore: published.hasMore,
    /* Named sources that could not be read. Empty is the happy answer. */
    faults,
    degraded: faults.length > 0,
  };
}

/**
 * The KPI strip — one count per view, plus what could not be read.
 *
 * Counts are exact over the whole company rather than over a page, so the strip
 * walks the published lines to exhaustion in bounded batches. Bounded, because
 * an unbounded scan behind a dashboard is how a screen becomes the reason a
 * database is slow.
 */
async function summary(ctx, { search = "", maxLines = 2000 } = {}) {
  assertContext(ctx);
  const faults = [];
  const counts = Object.fromEntries(VIEWS.map((v) => [v, 0]));
  let scanned = 0;
  let cursor = "";
  let truncated = false;

  for (;;) {
    const published = await guarded(faults, "MERCHANDISING_ORDER_LINE",
      () => merch.publishConfirmedOrderLines(ctx, { cursor, limit: MAX_LIMIT, search }), null);
    if (published === null) {
      throw fail("PPC_ORDER_BOOK_UNAVAILABLE",
        "The confirmed order lines could not be read, so the order book cannot be counted.",
        { faults });
    }
    if (!published.lines.length) break;

    const { rows } = await gather(ctx, published.lines, faults);
    for (const r of rows) { counts[r.view] += 1; counts[VIEW.ALL] += 1; }
    scanned += rows.length;

    if (!published.nextCursor) break;
    if (scanned >= maxLines) { truncated = true; break; }
    cursor = published.nextCursor;
  }

  return {
    counts,
    scanned,
    truncated,
    faults,
    degraded: faults.length > 0,
    /* The vocabulary travels with the numbers so a screen never invents a label
       for a state, and so "Couldn’t check" is spelled one way everywhere. */
    requiredInputs: REQUIRED_INPUTS,
    contextInputs: CONTEXT_INPUTS,
    inputWords: INPUT_WORDS,
  };
}

/**
 * One order line in full — the same classification, plus what a detail page
 * needs that a register row does not.
 */
async function orderLineDetail(ctx, { orderLineRef, executionFileId } = {}) {
  assertContext(ctx);
  const faults = [];
  const line = await guarded(faults, "MERCHANDISING_ORDER_LINE",
    () => merch.publishConfirmedOrderLine(ctx, { orderLineRef, executionFileId }), null);

  if (line === null && faults.length) {
    throw fail("PPC_ORDER_BOOK_UNAVAILABLE",
      "That order line could not be read. This is a failed read, not a missing line.", { faults });
  }
  if (!line) {
    throw fail("PPC_ORDER_LINE_NOT_FOUND",
      "No confirmed order line of yours has that reference.",
      { orderLineRef: str(orderLineRef) });
  }

  const { rows } = await gather(ctx, [line], faults);
  return {
    row: rows[0],
    /* The requirements, so a detail page can explain what is outstanding using
       the same words the register used. */
    requiredInputs: REQUIRED_INPUTS,
    contextInputs: CONTEXT_INPUTS,
    inputWords: INPUT_WORDS,
    faults,
    degraded: faults.length > 0,
  };
}

/**
 * The frozen basis as PPC shows it: versions, states and references.
 *
 * Receipt IDENTITIES are deliberately absent. They are provenance — the proof
 * that the acceptance which authorised the plan existed — and are held on the
 * record for audit, not printed. What a reader gets instead is whether each
 * receipt was frozen and at which version, which is the fact they can use.
 */
function publicSourceBasis(b = {}) {
  return {
    capturedAt: b.capturedAt ? new Date(b.capturedAt).toISOString() : null,
    confirmedQuantity: b.confirmedQuantity ?? null,
    earliestDeliveryDate: businessDateFromInstant(b.earliestDeliveryDate),
    deliveryRequirement: str(b.deliveryRequirement),
    deliveryCount: b.deliveryCount ?? 0,
    executionPackVersionNo: b.executionPackVersionNo ?? null,
    executionPackState: str(b.executionPackState),
    packReceiptState: str(b.packReceiptState),
    packReceiptFrozen: Boolean(b.packReceiptId),
    packReceiptVersionNo: b.packReceiptVersionNo ?? null,
    ieReleaseRef: str(b.ieReleaseRef),
    ieReleaseVersionNo: b.ieReleaseVersionNo ?? null,
    ieReleaseState: str(b.ieReleaseState),
    ieReceiptState: str(b.ieReceiptState),
    ieReceiptFrozen: Boolean(b.ieReceiptId),
    ieReceiptVersionNo: b.ieReceiptVersionNo ?? null,
    ppmVersionNo: b.ppmVersionNo ?? null,
    ppmState: str(b.ppmState),
    nominatedFactoryRef: str(b.nominatedFactoryRef),
  };
}

/**
 * The source-health comparison for a planning file: what it was planned
 * against, what is current, and what has moved between the two.
 */
async function sourceHealth(ctx, planningFile) {
  assertContext(ctx);
  const faults = [];
  const fileId = String(planningFile.executionFileId);

  const packs = await guarded(faults, "MERCHANDISING_EXECUTION_PACK",
    () => merch.publishCurrentExecutionPacks(ctx, [fileId]), null);
  const ppms = await guarded(faults, "MERCHANDISING_PPM",
    () => merch.publishIssuedMeetingMinutes(ctx, [fileId]), null);
  const line = await guarded(faults, "MERCHANDISING_ORDER_LINE",
    () => merch.publishConfirmedOrderLine(ctx, { executionFileId: fileId }), null);
  /* Re-read the frozen release BY ID, which is how "has that exact release
     moved" is asked — not by asking what the style's current release is. */
  const frozenRelease = planningFile.sourceBasis?.ieReleaseId
    ? await guarded(faults, "IE_RELEASE",
      () => ie.publishReleaseById(ctx, String(planningFile.sourceBasis.ieReleaseId)), null)
    : null;

  const movement = sourceMovement(planningFile.sourceBasis, {
    pack: packs === null ? undefined : (packs.get(fileId) || null),
    ppm: ppms === null ? undefined : (ppms.get(fileId) || null),
    release: frozenRelease === null && faults.some((f) => f.source === "IE_RELEASE")
      ? undefined : frozenRelease,
    line: line === null && faults.some((f) => f.source === "MERCHANDISING_ORDER_LINE")
      ? undefined : line,
  });

  return {
    frozen: publicSourceBasis(planningFile.sourceBasis),
    current: {
      executionPack: packs === null ? null : (packs.get(fileId) || null),
      ppmMinutes: ppms === null ? null : (ppms.get(fileId) || null),
      /* What the meeting recorded as reviewed, beside what this plan froze —
         both published, so a screen can show the disagreement rather than
         only the verdict. PPC reads this; it cannot write, approve, replace
         or manufacture it, and there is no path from here that would. */
      ppmReviewedIeRelease: ppms === null ? null
        : (ppms.get(fileId)?.reviewedIeRelease ?? null),
      ieRelease: frozenRelease,
      confirmedQuantity: line ? line.confirmedQuantity : null,
    },
    moved: movement.moved,
    movements: movement.movements,
    undetermined: movement.undetermined,
    /* Whether the meeting reviewed the release this plan froze, named. A
       contradiction is already in `movements` above and blocks; an absence is
       only here, so a screen can say what is missing without history being
       failed retroactively. */
    reviewedRelease: movement.reviewedRelease,
    faults,
    degraded: faults.length > 0,
  };
}

module.exports = {
  DEFAULT_LIMIT, MAX_LIMIT, MATERIAL_DEPARTMENTS,
  register, summary, orderLineDetail, sourceHealth,
  REVIEWED_RELEASE, REVIEWED_RELEASE_BLOCKING, REVIEWED_RELEASE_BLOCKING_AT_CREATION,
  CREATION_REASON, reviewedReleaseVerdict,
  /* Exported for the planning-file service, which must apply exactly the same
     readiness rule the register showed — not a second copy of it. */
  gather, classifyRow, sourceMovement, publicSourceBasis,
};

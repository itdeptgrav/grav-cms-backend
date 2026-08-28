// services/qcStages.js
//
// THE RULES OF THE QC LINE, IN ONE PLACE.
//
// Three screens ask the same questions and must never answer them differently:
// the inspection station (may I scan this piece here, right now?), the piece
// lookup (where has this piece got to?) and the overview (what happened today,
// and how much of it was rework?). Everything below is written once and read by
// all three; nothing here writes.
//
// THE MIGRATION RULE, AND IT IS THE SAME ONE THE REST OF THE CMS USES
// -------------------------------------------------------------------
// `requireDepartmentRole` fails OPEN for a department with no roles assigned,
// so that shipping it does not lock out eleven departments before anybody has
// had a chance to configure them. Stages take the identical position, at two
// levels:
//
//   NO STAGES CONFIGURED  → the station behaves exactly as it did before this
//                           existed. Scan, verdict, saved. No locks.
//   STAGES BUT NO ROSTER  → stages are recorded on every scan, but nobody is
//                           refused for standing at the wrong checkpoint,
//                           because "the wrong checkpoint" is not yet a fact
//                           anyone has stated.
//   STAGES AND A ROSTER   → fully enforced.
//
// This is what makes the feature safe to deploy onto a running floor: it turns
// itself on as the owner configures it, one step at a time, rather than all at
// once at 6am.

"use strict";

const QCStage = require("../models/CMS_Models/Manufacturing/QC/QCStage");
const QCStageAssignment = require("../models/CMS_Models/Manufacturing/QC/QCStageAssignment");
const QCInspection = require("../models/CMS_Models/Manufacturing/QC/DefectRecord");

/* ------------------------------------------------------------------ */
/* Stages                                                              */
/* ------------------------------------------------------------------ */

/** Every active stage, in line order. The canonical ordering for the whole app. */
async function listStages({ includeRetired = false } = {}) {
  const filter = includeRetired ? {} : { isActive: true };
  return QCStage.find(filter).sort({ serial: 1, createdAt: 1 }).lean();
}

/** Are stages configured at all? Decides whether any of the rules below apply. */
async function stagesConfigured() {
  const n = await QCStage.countDocuments({ isActive: true });
  return n > 0;
}

/* ------------------------------------------------------------------ */
/* The roster                                                          */
/* ------------------------------------------------------------------ */

/**
 * Assignments in force at `at`, optionally narrowed to one person.
 *
 * `person` may carry an email, a biometricId, or both. They are OR-ed rather
 * than AND-ed: the station knows a scanner by biometric id and the CMS knows
 * them by email, and an assignment made before the employee record carried a
 * biometric id has only the email. Requiring both would silently roster nobody.
 */
async function activeAssignments({ at = new Date(), person = null, stageId = null } = {}) {
  const filter = QCStageAssignment.windowFilter(at);
  if (stageId) filter.stageId = stageId;

  if (person) {
    const or = [];
    if (person.email) or.push({ email: String(person.email).toLowerCase().trim() });
    if (person.biometricId) or.push({ biometricId: String(person.biometricId).trim() });
    // Nothing to match on — no email, no biometric id. Return nothing rather
    // than everything; a caller with no identity must not inherit the roster.
    if (!or.length) return [];
    // windowFilter already owns `$or`, so the identity match goes in as an
    // $and clause instead of overwriting it.
    filter.$and = [{ $or: or }];
  }

  return QCStageAssignment.find(filter).sort({ validFrom: -1 }).lean();
}

/**
 * The stages one person may scan at right now, in line order.
 *
 * Returns `{ enforced, stages }`. `enforced: false` means the roster is empty
 * across the whole department — see the migration rule at the top — and the
 * caller should treat every stage as available rather than none.
 */
async function stagesForPerson(person, at = new Date()) {
  const [stages, mine, rosterSize] = await Promise.all([
    listStages(),
    activeAssignments({ at, person }),
    QCStageAssignment.countDocuments(QCStageAssignment.windowFilter(at)),
  ]);

  if (!stages.length) return { enforced: false, stages: [], assignments: [] };
  if (rosterSize === 0) return { enforced: false, stages, assignments: [] };

  const mineIds = new Set(mine.map((a) => String(a.stageId)));
  return {
    enforced: true,
    stages: stages.filter((s) => mineIds.has(String(s._id))),
    assignments: mine,
  };
}

/* ------------------------------------------------------------------ */
/* A piece's progress through the line                                 */
/* ------------------------------------------------------------------ */

/**
 * Fold a piece's inspections into one state per stage.
 *
 * @param {Array}  inspections  every inspection for ONE barcode, any order
 * @param {Array}  stages       active stages in line order
 *
 * Per stage: "pending" (never scanned), "passed" (latest verdict passed) or
 * "rework" (latest verdict defective — the piece was sent back and has not
 * come back clean).
 *
 * WHY "LATEST WINS" AND NOT "ANY FAILURE STICKS". A stage that failed and was
 * later re-inspected clean is done: that is what rework IS. The failures are
 * not forgotten — they are counted in `reworkCount`, which is the figure the
 * per-product and per-customer rollups report. Conflating the two would make a
 * piece that was fixed indistinguishable from one that never was.
 */
function buildPieceProgress(inspections = [], stages = []) {
  const byStage = new Map();
  const ordered = [...inspections].sort(
    (a, b) => new Date(a.inspectedAt) - new Date(b.inspectedAt),
  );

  // Scans taken before stages existed, or at a stage since retired, still
  // belong to the piece — they are reported separately rather than dropped.
  const unstaged = [];

  for (const insp of ordered) {
    const key = insp.stageId ? String(insp.stageId) : null;
    if (!key) { unstaged.push(insp); continue; }
    if (!byStage.has(key)) byStage.set(key, []);
    byStage.get(key).push(insp);
  }

  const stageStates = stages.map((s) => {
    const records = byStage.get(String(s._id)) || [];
    const latest = records[records.length - 1] || null;
    // Only a REWORK verdict counts as rework. A scrapped piece was not sent
    // back and will never come back, so counting it would inflate the one
    // figure that is supposed to measure work redone.
    const defectiveCount = records.filter((r) => r.status === "defective").length;

    return {
      stageId: String(s._id),
      stageCode: s.code,
      stageName: s.name,
      serial: s.serial,
      state: !latest
        ? "pending"
        : latest.status === "passed"
          ? "passed"
          : latest.status === "rejected"
            ? "rejected"
            : "rework",
      scans: records.length,
      reworkCount: defectiveCount,
      // THE SEQUENCE, NOT JUST THE TALLY. "1 rework" and "passed" are two
      // facts that, side by side, do not say which came first — and the order
      // is the whole story of a piece: rejected, rejected again, then passed
      // reads completely differently from passed, then rejected. The counts
      // above stay because every rollup adds them up; this is what the row
      // itself is rendered from.
      history: records.map((r) => ({
        status: r.status,
        at: r.inspectedAt,
        by: r.inspectedByQCName || "",
        biometricId: r.inspectedByBiometricId || "",
      })),
      latestAt: latest?.inspectedAt || null,
      latestStatus: latest?.status || null,
      inspectedByQCName: latest?.inspectedByQCName || "",
      inspectedByBiometricId: latest?.inspectedByBiometricId || "",
      // Every inspector who has touched this piece at this stage, oldest first.
      // The rework loop is usually a different person the second time round.
      inspectors: [
        ...new Map(
          records
            .filter((r) => r.inspectedByQCName)
            .map((r) => [
              r.inspectedByBiometricId || r.inspectedByQCName,
              { name: r.inspectedByQCName, biometricId: r.inspectedByBiometricId || "" },
            ]),
        ).values(),
      ],
    };
  });

  // A stage held by another inspector who passed it is closed to everyone —
  // that is the overwrite rule — so "where is this piece" is simply the first
  // checkpoint it has not cleared.
  const current = stageStates.find((s) => s.state !== "passed") || null;
  const openRework = stageStates.filter((s) => s.state === "rework");

  /**
   * SCRAPPED — and it does not matter where, or when, or by whom afterwards.
   *
   * Looked for across EVERY record rather than just the latest at each stage,
   * because a reject is not a state a piece can leave. If a piece was rejected
   * at end-line on Monday, the fact that somebody's earlier in-line pass is
   * still the "latest" record at in-line changes nothing: the garment is in a
   * bin. `unstaged` is searched too — a reject recorded before checkpoints
   * existed is still a reject.
   */
  const rejection =
    ordered.find((r) => r.status === "rejected") ||
    unstaged.find((r) => r.status === "rejected") ||
    null;

  return {
    stages: stageStates,
    rejected: Boolean(rejection),
    rejectedAt: rejection?.inspectedAt || null,
    rejectedBy: rejection?.inspectedByQCName || "",
    rejectedStage: rejection
      ? stageStates.find((s) => s.stageId === String(rejection.stageId || ""))?.stageName || ""
      : "",
    // Total times this piece was sent back, across every checkpoint. This is
    // the number the product and customer rollups add up.
    reworkCount: stageStates.reduce((n, s) => n + s.reworkCount, 0)
      + unstaged.filter((r) => r.status === "defective").length,
    currentStage: current
      ? { stageId: current.stageId, stageCode: current.stageCode, stageName: current.stageName, serial: current.serial, state: current.state }
      : null,
    // Every checkpoint cleared, nothing open. Only then is the PIECE passed —
    // as opposed to one checkpoint on it having passed. A scrapped piece is
    // never complete however many checkpoints it cleared before it was binned.
    complete: !rejection && stageStates.length > 0 && stageStates.every((s) => s.state === "passed"),
    openRework: openRework.map((s) => ({
      stageId: s.stageId, stageCode: s.stageCode, stageName: s.stageName, serial: s.serial,
    })),
    unstagedScans: unstaged.length,
  };
}

/** Same, but fetches the piece's inspections itself. */
async function pieceProgress(barcodeId, stages = null) {
  const [resolvedStages, inspections] = await Promise.all([
    stages || listStages(),
    QCInspection.find({ barcodeId: String(barcodeId).trim() })
      .select("stageId status inspectedAt inspectedByQCName inspectedByBiometricId reworkRound")
      .lean(),
  ]);
  return buildPieceProgress(inspections, resolvedStages);
}

/**
 * Progress for MANY pieces in one round trip.
 *
 * The overview draws a stage strip on every row. Calling pieceProgress() per
 * row is a query per piece — a few hundred on a normal day, which is what took
 * the old per-row "fetch operator" button from a button to a page freeze. One
 * $in and a group in memory instead.
 */
async function pieceProgressMany(barcodeIds = [], stages = null) {
  const ids = [...new Set(barcodeIds.filter(Boolean).map((b) => String(b).trim()))];
  if (!ids.length) return {};

  const [resolvedStages, inspections] = await Promise.all([
    stages || listStages(),
    QCInspection.find({ barcodeId: { $in: ids } })
      .select("barcodeId stageId status inspectedAt inspectedByQCName inspectedByBiometricId")
      .lean(),
  ]);

  const grouped = new Map(ids.map((id) => [id, []]));
  for (const insp of inspections) {
    const bucket = grouped.get(insp.barcodeId);
    if (bucket) bucket.push(insp);
  }

  const out = {};
  for (const [id, records] of grouped) out[id] = buildPieceProgress(records, resolvedStages);
  return out;
}

/* ------------------------------------------------------------------ */
/* The scan guard                                                      */
/* ------------------------------------------------------------------ */

/**
 * May this person record THIS verdict on THIS piece at THIS checkpoint?
 *
 * Returns `{ allowed, code, message, reworkRound, stage, progress }`. The
 * station calls it to decide what to offer BEFORE anybody presses anything,
 * and the save route calls it again to decide whether to write — the same
 * function both times, so the screen can never offer a button the server will
 * refuse.
 *
 * The four refusals, and why each exists:
 *
 *   STAGE_ALREADY_PASSED    Somebody already passed this piece here. A second
 *                           scan at a cleared checkpoint can only overwrite a
 *                           verdict that was already given — which is the exact
 *                           thing the roster was built to prevent, since two
 *                           people share a checkpoint and both have the piece
 *                           in front of them at different moments.
 *
 *   NOT_ASSIGNED_TO_STAGE   The person is not on this checkpoint's roster right
 *                           now. Not a permission error in the RBAC sense —
 *                           they are a perfectly valid inspector — but a scan
 *                           attributed to the wrong checkpoint corrupts every
 *                           figure downstream.
 *
 *   BLOCKED_BY_REWORK       A pass cannot be given while the piece is still
 *                           failed at another checkpoint. Until that is cleared
 *                           the piece is not good, whatever this checkpoint
 *                           thinks of it, and it keeps counting as rework.
 *
 *   UNKNOWN_STAGE           The stage was retired or never existed.
 */
/**
 * The rules themselves, over already-fetched facts.
 *
 * SPLIT OUT FROM THE FETCHING ON PURPOSE. The station asks this question about
 * every checkpoint at once, to decide what to offer before anybody presses
 * anything; the save route asks it about one checkpoint, to decide whether to
 * write. If those were two implementations they would drift, and the drift
 * would show up as a button that is refused when pressed. They are one
 * function, called with the same facts, and the fetching around it differs
 * instead.
 */
function judgeScan({ stage, progress, status, rostered, rosterEnforced }) {
  const here = progress.stages.find((s) => s.stageId === String(stage._id));

  // ── SCRAP IS FINAL, and this check is first because nothing after it can
  //    matter. A rejected garment is in a bin; there is no verdict anybody can
  //    record about it that is true, including another reject. Scanning it
  //    again — which happens, because a barcode on a bin still scans — must do
  //    nothing at all rather than quietly appending a record that could later
  //    read as the piece's current state.
  if (progress.rejected) {
    return {
      allowed: false,
      code: "PIECE_REJECTED",
      enforced: true,
      stage,
      progress,
      rejectedBy: { name: progress.rejectedBy, at: progress.rejectedAt, stage: progress.rejectedStage },
      message: progress.rejectedBy
        ? `This piece was rejected by ${progress.rejectedBy}${progress.rejectedStage ? ` at ${progress.rejectedStage}` : ""}. A rejected piece cannot be inspected again.`
        : "This piece has been rejected. A rejected piece cannot be inspected again.",
    };
  }

  // ── The roster, once there is one. ──
  if (rosterEnforced && !rostered) {
    return {
      allowed: false,
      code: "NOT_ASSIGNED_TO_STAGE",
      enforced: true,
      stage,
      progress,
      message: `You are not on the ${stage.name} roster right now. Ask the QC owner to assign you.`,
    };
  }

  // ── The overwrite lock. Applies to everyone, the person who passed it
  //    included: a cleared checkpoint is a fact, not a draft. ──
  if (here && here.state === "passed") {
    const who = here.inspectedByQCName || "another inspector";
    return {
      allowed: false,
      code: "STAGE_ALREADY_PASSED",
      enforced: true,
      stage,
      progress,
      passedBy: { name: here.inspectedByQCName, biometricId: here.inspectedByBiometricId, at: here.latestAt },
      message: `${stage.name} was already passed by ${who}. It cannot be scanned again here.`,
    };
  }

  // ── The rework block. A checkpoint may always re-inspect its OWN open
  //    rework — that is how rework is cleared — but no checkpoint may declare
  //    a piece good while another one still holds it failed. ──
  // Note this does NOT apply to a reject: scrapping a garment that is also in
  // rework somewhere is exactly what happens when the rework turns out to be
  // impossible, and refusing it would leave the piece stuck in a queue forever.
  const blocking = progress.openRework.filter((s) => s.stageId !== String(stage._id));
  if (status === "passed" && blocking.length) {
    const names = blocking.map((s) => s.stageName).join(", ");
    return {
      allowed: false,
      code: "BLOCKED_BY_REWORK",
      enforced: true,
      stage,
      progress,
      blockedBy: blocking,
      message: `This piece is still in rework at ${names}. It cannot be passed until that is cleared.`,
    };
  }

  return {
    allowed: true,
    code: "OK",
    enforced: true,
    stage,
    progress,
    // A re-inspection of work already sent back from this checkpoint.
    reworkRound: here ? here.reworkCount : 0,
  };
}

/**
 * What this person may do at EVERY checkpoint on this piece, in one pass.
 *
 * Two verdicts per stage, because they refuse for different reasons and the
 * station needs to say which: a checkpoint can be open for a defect but closed
 * for a pass, when the piece is still failed somewhere else.
 */
async function stageGuardsForPiece({ barcodeId, person = {}, at = new Date() }) {
  const stages = await listStages();
  if (!stages.length) {
    return { enforced: false, rosterEnforced: false, stages: [], guards: [], progress: null };
  }

  const [progress, rosterSize, mine] = await Promise.all([
    pieceProgress(barcodeId, stages),
    QCStageAssignment.countDocuments(QCStageAssignment.windowFilter(at)),
    activeAssignments({ at, person }),
  ]);

  const rosterEnforced = rosterSize > 0;
  const mineIds = new Set(mine.map((a) => String(a.stageId)));

  const guards = stages.map((stage) => {
    const rostered = !rosterEnforced || mineIds.has(String(stage._id));
    const pass = judgeScan({ stage, progress, status: "passed", rostered, rosterEnforced });
    const defect = judgeScan({ stage, progress, status: "defective", rostered, rosterEnforced });
    const reject = judgeScan({ stage, progress, status: "rejected", rostered, rosterEnforced });
    return {
      stageId: String(stage._id),
      stageCode: stage.code,
      stageName: stage.name,
      serial: stage.serial,
      rostered,
      canPass: pass.allowed,
      canFail: defect.allowed,
      canReject: reject.allowed,
      // The defect verdict's message is the honest general reason: a stage
      // open for a defect but closed for a pass is not "blocked", it is
      // waiting on rework elsewhere, and the pass message says exactly that.
      reason: defect.allowed ? (pass.allowed ? null : pass.message) : defect.message,
      code: defect.allowed ? (pass.allowed ? "OK" : pass.code) : defect.code,
      reworkRound: defect.reworkRound ?? 0,
    };
  });

  return { enforced: true, rosterEnforced, stages, guards, progress };
}

async function evaluateScan({
  barcodeId,
  stageId,
  status,
  person = {},
  at = new Date(),
}) {
  const stages = await listStages();

  // ── Nothing configured: the station works exactly as it always has. ──
  if (!stages.length) {
    return { allowed: true, code: "NO_STAGES", enforced: false, stage: null, reworkRound: 0, progress: null };
  }

  if (!stageId) {
    return {
      allowed: false,
      code: "STAGE_REQUIRED",
      enforced: true,
      message: "Choose the checkpoint you are inspecting at.",
    };
  }

  const stage = stages.find((s) => String(s._id) === String(stageId));
  if (!stage) {
    return {
      allowed: false,
      code: "UNKNOWN_STAGE",
      enforced: true,
      message: "That checkpoint no longer exists. Refresh and pick another.",
    };
  }

  const [progress, rosterSize, mine] = await Promise.all([
    pieceProgress(barcodeId, stages),
    QCStageAssignment.countDocuments(QCStageAssignment.windowFilter(at)),
    activeAssignments({ at, person, stageId: stage._id }),
  ]);

  return judgeScan({
    stage,
    progress,
    status,
    rostered: mine.length > 0,
    rosterEnforced: rosterSize > 0,
  });
}

module.exports = {
  listStages,
  stagesConfigured,
  activeAssignments,
  stagesForPerson,
  buildPieceProgress,
  pieceProgress,
  pieceProgressMany,
  judgeScan,
  stageGuardsForPiece,
  evaluateScan,
};

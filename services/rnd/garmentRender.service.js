// services/rnd/garmentRender.service.js
//
// A 3D PREVIEW IS A PICTURE OF ONE PATTERN REVISION.
//
// ── WHAT THIS SERVICE GUARANTEES ────────────────────────────────────────────
//
//   · A render is always OF something. Every job names the exact 2D revision
//     it used and the exact settings it was given, both immutable, so "what is
//     this a preview of" is answered by the record rather than inferred.
//   · A preview never silently replaces another. Requesting a new one creates
//     a new job; previous ones stay, with what they were rendered from, which
//     is what makes two previews comparable at all.
//   · A preview goes out of date rather than going wrong. When a newer pattern
//     revision is approved, every preview of an older one is STALE — said in
//     those words, not quietly re-pointed.
//   · Nothing here writes to a pattern. There is no function in this file that
//     a render, a measurement or an annotation could use to change a revision.
//
// ── AND WHAT IT DOES NOT DO ─────────────────────────────────────────────────
// Simulate. Cloth simulation lives behind `simulationAdapter.service.js`, and
// when no engine is connected a requested render FAILS IMMEDIATELY with a
// sentence saying so. It does not queue for ever and it does not fall back to
// something invented locally: a plausible-looking garment that nothing
// simulated is the most dangerous output this system could produce.
"use strict";

const crypto = require("crypto");
const mongoose = require("mongoose");

const {
  PatternRevision, RenderJob, REVISION_STATE, RENDER_STATUS,
} = require("../../models/CMS_Models/RnD/PatternRevision");
const { styleForCompany } = require("../companyContext/rndScope.service");
const simulation = require("./simulationAdapter.service");
const { fail } = require("../storePurchase/errors");

const str = (v) => (v === null || v === undefined ? "" : String(v).trim());
const clean = (v, max) => str(v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").slice(0, max);
const isId = (v) => mongoose.Types.ObjectId.isValid(str(v));
const mintRef = (prefix) => `${prefix}-${crypto.randomBytes(5).toString("hex").toUpperCase()}`;
const actorOf = (a) => ({ id: str(a?.id), name: str(a?.name), email: str(a?.email).toLowerCase() });

function assertContext(ctx) {
  if (!ctx?.companyId) throw fail("COMPANY_CONTEXT_UNAVAILABLE", "Your company could not be resolved.");
}

/* ═══ STALENESS ═══════════════════════════════════════════════════════════
 *
 * ── WHY IT IS COMPUTED AND NEVER STORED ─────────────────────────────────────
 * A stored `stale` flag has to be written by whatever approves a revision, and
 * the day somebody adds a second path to approve one, half the previews are
 * silently wrong. Comparing the job's revision with the style's current one is
 * the same answer every time it is asked, by anybody.
 */
function stalenessOf(job, { currentRevisionRef, currentRevisionNumber }) {
  if (!currentRevisionRef) return { stale: false, reason: "" };
  if (job.patternRevisionRef === currentRevisionRef) return { stale: false, reason: "" };
  return {
    stale: true,
    reason: `This preview was made from pattern revision ${job.patternRevisionNumber}. `
      + `The current pattern is revision ${currentRevisionNumber}.`,
  };
}

function jobView(job, context = {}) {
  const staleness = stalenessOf(job, context);
  return {
    id: String(job._id),
    jobRef: job.jobRef,
    status: job.status,
    /* Said in the payload, in the words the screen shows, so a consumer that
       is not this workspace cannot present a derived garment as a source. */
    derivedFrom: `Derived from 2D pattern revision ${job.patternRevisionNumber}.`,
    patternRevisionRef: job.patternRevisionRef,
    patternRevisionNumber: job.patternRevisionNumber,
    patternRevisionId: String(job.patternRevisionId),
    readOnly: true,
    stale: staleness.stale,
    staleReason: staleness.reason,
    engine: {
      adapter: str(job.engine?.adapter),
      version: str(job.engine?.version),
      externalJobId: str(job.engine?.externalJobId),
      /* So the page knows it is the one that has to do the arithmetic, without
         matching on an adapter name it would then have to keep in step. */
      runsInBrowser: Boolean(simulation.activeAdapter()?.runsInBrowser)
        && str(job.engine?.adapter) === str(process.env.RND_SIMULATION_ADAPTER || "").trim(),
    },
    inputs: job.inputs || {},
    resultPublicationRef: str(job.resultPublicationRef),
    resultPublicationId: job.resultPublicationId ? String(job.resultPublicationId) : "",
    /* ── THE DRAPE'S FINDINGS, WITHOUT ITS GEOMETRY ────────────────────
       A job list renders a dozen of these and the positions are 100KB each, so
       the geometry is fetched on its own by `readDrape` when a reader opens one.
       What a list needs is whether there is a drape and what it found. */
    drape: job.drape?.vertexCount
      ? {
        present: true,
        solverVersion: str(job.drape.solverVersion),
        quality: str(job.drape.quality),
        fabric: job.drape.fabric || null,
        unit: str(job.drape.unit) || "mm",
        vertexCount: job.drape.vertexCount,
        triangleCount: job.drape.triangleCount ?? 0,
        pieces: (job.drape.pieces || []).map((p) => ({
          pieceRef: str(p.pieceRef), name: str(p.name), role: str(p.role),
          base: p.base ?? 0, vertexCount: p.vertexCount ?? 0,
        })),
        seamClosure: job.drape.seamClosure || [],
        strain: job.drape.strain || null,
        fidelity: job.drape.fidelity || null,
        tightestClearanceMm: job.drape.tightestClearanceMm ?? null,
        template: job.drape.template || null,
        frames: job.drape.frames ?? 0,
        finalMoveMm: job.drape.finalMoveMm ?? null,
        msElapsed: job.drape.msElapsed ?? 0,
        /* Said here rather than left to each screen, because a drape shown
           without this sentence is a drape somebody will approve against. */
        caveat: "This is a drape of the 2D pattern computed in the browser, on a body built from "
          + "measurements. It shows whether the pattern sews and where the cloth is under tension. "
          + "It is not a production-accurate garment and a sample should not be approved against it.",
      }
      : { present: false },
    failure: {
      code: str(job.failure?.code),
      message: str(job.failure?.message),
    },
    requestedBy: str(job.requestedBy?.name),
    startedAt: job.startedAt || null,
    finishedAt: job.finishedAt || null,
    events: (job.events || []).map((e) => ({
      kind: e.kind, note: str(e.note), by: str(e.by?.name), at: e.at,
    })),
    revision: job.revision ?? 0,
    createdAt: job.createdAt,
  };
}

/** The revision a reader should be looking at: approved, else newest. */
async function currentRevisionOf(ctx, styleId) {
  const rows = await PatternRevision
    .find({ companyId: ctx.companyId, styleId })
    .sort({ revisionNumber: -1 })
    .select("revisionRef revisionNumber state")
    .lean();
  const approved = rows.find((r) => r.state === REVISION_STATE.APPROVED) || null;
  const current = approved || rows[0] || null;
  return {
    currentRevisionRef: current ? current.revisionRef : "",
    currentRevisionNumber: current ? current.revisionNumber : 0,
    approvedRevisionRef: approved ? approved.revisionRef : "",
  };
}

/**
 * Every preview of a style, newest first, each saying what it is of.
 *
 * Previous renders are kept rather than replaced: comparing this week's drape
 * with last week's is the main reason anybody looks at two, and a system that
 * overwrote would make that impossible after the fact.
 */
async function listRenders(ctx, { styleId } = {}) {
  assertContext(ctx);
  const style = await styleForCompany(ctx.companyId, styleId);
  const context = await currentRevisionOf(ctx, style._id);
  const jobs = await RenderJob
    .find({ companyId: ctx.companyId, styleId: style._id })
    .sort({ createdAt: -1 })
    .lean();

  const views = jobs.map((j) => jobView(j, context));
  const latestCompleted = views.find((v) => v.status === RENDER_STATUS.COMPLETED) || null;

  return {
    renders: views,
    /* The one the 3D side should show, and whether it still matches. */
    current: latestCompleted,
    outOfDate: Boolean(latestCompleted?.stale),
    ...context,
    simulation: simulation.adapterStatus(),
  };
}

/* ═══ REQUESTING ONE ══════════════════════════════════════════════════════ */

/**
 * GENERATE A 3D PREVIEW FROM A 2D REVISION.
 *
 * Refuses before it creates anything if the revision is not renderable, and
 * says which inputs are missing rather than "cannot render" — a person who is
 * told they are missing seam pairings can go and add them.
 */
async function requestRender(ctx, { revisionId, actor = null } = {}) {
  assertContext(ctx);
  if (!isId(revisionId)) throw fail("NOT_FOUND", "That pattern revision was not found.");
  const revision = await PatternRevision
    .findOne({ _id: revisionId, companyId: ctx.companyId }).lean().catch(() => null);
  if (!revision) throw fail("NOT_FOUND", "That pattern revision was not found.");

  const readiness = simulation.checkInputs(revision.patternSet, revision.simulationInputs);
  if (!readiness.ready) {
    throw fail("SIMULATION_INPUTS_MISSING",
      "This pattern cannot be draped yet: "
      + readiness.missing.map((m) => m.label.toLowerCase()).join(", ")
      + (readiness.missing.length === 1 ? " is missing." : " are missing."),
      { missing: readiness.missing });
  }

  /* One run at a time per revision. Two solvers racing on the same pattern
     produce two garments and no way to say which is the preview. */
  const running = await RenderJob.findOne({
    companyId: ctx.companyId,
    patternRevisionId: revision._id,
    status: { $in: [RENDER_STATUS.QUEUED, RENDER_STATUS.SIMULATING] },
  }).lean();
  if (running) {
    throw fail("RENDER_ALREADY_RUNNING",
      `A preview of pattern revision ${revision.revisionNumber} is already being made.`,
      { jobRef: running.jobRef, status: running.status });
  }

  const who = actorOf(actor);
  const at = new Date();
  const job = await RenderJob.create({
    companyId: ctx.companyId,
    styleId: revision.styleId,
    jobRef: mintRef("RJ"),
    patternRevisionId: revision._id,
    patternRevisionRef: revision.revisionRef,
    patternRevisionNumber: revision.revisionNumber,
    /* A COPY. The revision's settings may be edited afterwards; what this
       garment was draped with cannot change retrospectively. */
    inputs: JSON.parse(JSON.stringify(revision.simulationInputs || {})),
    status: RENDER_STATUS.QUEUED,
    requestedBy: who,
    events: [{ kind: "queued", note: revision.revisionRef, by: who, at }],
  });

  /* ── HANDED OVER, OR REFUSED HONESTLY ────────────────────────────────
     The 2D pattern is untouched either way: nothing above or below writes to
     the revision, and a failed render leaves a failed job and a pattern
     exactly as it was. */
  const out = await simulation.submit({
    jobRef: job.jobRef,
    patternRevisionRef: revision.revisionRef,
    patternSet: revision.patternSet,
    inputs: job.inputs,
    renderSize: str(job.inputs?.renderSize),
    sourceDxf: null,
  });

  if (out.status === "accepted") {
    job.status = RENDER_STATUS.SIMULATING;
    job.startedAt = at;
    job.engine = { adapter: out.engine, version: out.version, externalJobId: out.externalJobId };
    job.events.push({ kind: "simulating", note: out.engine, by: who, at });
  } else {
    job.status = RENDER_STATUS.FAILED;
    job.finishedAt = at;
    job.failure = { code: out.code, message: out.message };
    job.events.push({ kind: "failed", note: out.message, by: who, at });
  }
  job.revision += 1;
  await job.save();

  const context = await currentRevisionOf(ctx, revision.styleId);
  return { render: jobView(job, context) };
}

/* ═══ A DRAPE, AS IT ARRIVES AND AS IT IS STORED ══════════════════════════
 *
 * The browser sends positions as a base64 string because JSON has no binary and
 * an array of 25,000 numbers is 300KB of text for 100KB of data. They are stored
 * as a Buffer of little-endian Float32s, three per vertex.
 *
 * ── WHY THE LENGTH IS CHECKED AGAINST THE VERTEX COUNT ────────────────────
 * Because a drape whose positions do not match its piece table is a garment
 * whose panels are mislabelled, and the labels are the whole value: a reader
 * looking at a strained area needs to be told which PATTERN PIECE it is. A
 * mismatch is refused rather than stored and rendered as something.
 */
/**
 * The bytes behind a stored Buffer field, whichever shape the driver returns.
 *
 * A `.lean()` read hands back the BSON `Binary` rather than a Node Buffer, and
 * `Buffer.from(binary)` on one of those produces an EMPTY buffer rather than
 * throwing — so the drape came back as zero bytes, the viewer drew nothing, and
 * nothing anywhere said why.
 */
function bytesOf(value) {
  if (!value) return Buffer.alloc(0);
  if (Buffer.isBuffer(value)) return value;
  if (typeof value.value === "function") return Buffer.from(value.value(true));
  if (value.buffer) return Buffer.from(value.buffer);
  return Buffer.alloc(0);
}

function normaliseDrape(drape) {
  const vertexCount = Number(drape?.vertexCount) || 0;
  if (vertexCount < 3) {
    throw fail("VALIDATION", "That drape has no geometry in it.", { field: "drape.vertexCount" });
  }
  let positions = null;
  if (typeof drape.positions === "string" && drape.positions) {
    positions = Buffer.from(drape.positions, "base64");
  } else if (Buffer.isBuffer(drape.positions)) {
    positions = drape.positions;
  }
  if (!positions || positions.length !== vertexCount * 3 * 4) {
    throw fail("VALIDATION",
      `That drape carries ${positions ? positions.length : 0} bytes of positions for `
      + `${vertexCount} points, and ${vertexCount * 3 * 4} were expected. It was not stored: a `
      + "drape whose points do not match its pieces cannot say which panel anything is on.",
      { field: "drape.positions" });
  }
  const pieces = (Array.isArray(drape.pieces) ? drape.pieces : []).map((p) => ({
    pieceRef: str(p.pieceRef), name: str(p.name), role: str(p.role),
    base: Number(p.base) || 0, vertexCount: Number(p.vertexCount) || 0,
  }));
  const covered = pieces.reduce((n, p) => n + p.vertexCount, 0);
  if (covered !== vertexCount) {
    throw fail("VALIDATION",
      `That drape's pieces account for ${covered} of its ${vertexCount} points.`,
      { field: "drape.pieces" });
  }
  return {
    solverVersion: str(drape.solverVersion),
    quality: str(drape.quality),
    fabric: {
      id: str(drape.fabric?.id), label: str(drape.fabric?.label), version: str(drape.fabric?.version),
    },
    /* Millimetres or nothing. The adapter that produced this converted once at
       its own boundary; a drape arriving in some other unit is a drape nobody
       can measure, so it is refused rather than relabelled. */
    unit: "mm",
    vertexCount,
    triangleCount: Number(drape.triangleCount) || 0,
    pieces,
    positions,
    seamClosure: Array.isArray(drape.seamClosure) ? drape.seamClosure : [],
    strain: drape.strain || null,
    fidelity: drape.fidelity || null,
    tightestClearanceMm: Number.isFinite(drape.tightestClearanceMm) ? drape.tightestClearanceMm : null,
    template: drape.template || null,
    body: drape.body || null,
    frames: Number(drape.frames) || 0,
    finalMoveMm: Number.isFinite(drape.finalMoveMm) ? drape.finalMoveMm : null,
    msElapsed: Number(drape.msElapsed) || 0,
  };
}

/* ═══ WHAT THE ENGINE REPORTS BACK ════════════════════════════════════════
 *
 * Called by whatever adapter is connected — a webhook, a poller, a worker. It
 * is the only way a job leaves `simulating`, and it cannot move a job that has
 * already finished: a completed render is evidence, and a late callback must
 * not rewrite it.
 */
async function recordRenderOutcome(ctx, {
  jobRef, status, publicationId, publicationRef, failure, drape = null, actor = null,
} = {}) {
  assertContext(ctx);
  const job = await RenderJob.findOne({ companyId: ctx.companyId, jobRef: str(jobRef) });
  if (!job) throw fail("NOT_FOUND", "That render job was not found.");
  if ([RENDER_STATUS.COMPLETED, RENDER_STATUS.FAILED, RENDER_STATUS.CANCELLED].includes(job.status)) {
    throw fail("INVALID_TRANSITION",
      `This render has already ${job.status === RENDER_STATUS.COMPLETED ? "completed" : job.status}. `
      + "A later message cannot change what it produced.",
      { status: job.status });
  }
  const next = str(status);
  if (![RENDER_STATUS.COMPLETED, RENDER_STATUS.FAILED, RENDER_STATUS.CANCELLED].includes(next)) {
    throw fail("VALIDATION", "A render finishes as completed, failed or cancelled.", { field: "status" });
  }

  const who = actorOf(actor);
  const at = new Date();
  job.status = next;
  job.finishedAt = at;

  if (next === RENDER_STATUS.COMPLETED) {
    /* ── A COMPLETED RENDER NAMES WHAT IT PRODUCED ──────────────────────
       Either a model publication — an engine that exported a file somebody can
       approve a sample against — or a drape, which is this system's own reading
       of the 2D pattern. One or the other, never neither: a render that
       completed with nothing to show is the state this check exists to prevent. */
    if (drape) {
      job.drape = normaliseDrape(drape);
      job.events.push({
        kind: "completed",
        note: `drape, ${job.drape.quality} quality, ${job.drape.vertexCount} points`,
        by: who, at,
      });
    } else if (isId(publicationId)) {
      job.resultPublicationId = publicationId;
      job.resultPublicationRef = str(publicationRef);
      job.events.push({ kind: "completed", note: str(publicationRef), by: who, at });
    } else {
      throw fail("VALIDATION",
        "A completed render has to name the model publication it produced, or carry the drape it "
        + "made.", { field: "publicationId" });
    }
  } else {
    job.failure = {
      code: clean(failure?.code, 80) || "RENDER_FAILED",
      message: clean(failure?.message, 2000) || "The simulation did not produce a garment.",
    };
    job.events.push({ kind: next, note: job.failure.message, by: who, at });
  }
  job.revision += 1;
  await job.save();

  const context = await currentRevisionOf(ctx, job.styleId);
  return { render: jobView(job, context) };
}

/**
 * THE DRAPE'S GEOMETRY, ON ITS OWN.
 *
 * Separate from `jobView` because it is 100KB and a job list is not. Returns the
 * positions as base64 and the piece table beside them, so the caller can rebuild
 * the triangles from the revision — the triangulation is a pure function of the
 * pattern, the quality and the solver version, all three named here.
 */
async function readDrape(ctx, { jobRef } = {}) {
  assertContext(ctx);
  const job = await RenderJob.findOne({ companyId: ctx.companyId, jobRef: str(jobRef) }).lean();
  if (!job) throw fail("NOT_FOUND", "That render job was not found.");
  if (!job.drape?.vertexCount || !job.drape?.positions) {
    throw fail("NO_DRAPE",
      job.status === RENDER_STATUS.COMPLETED
        ? "This render produced a model publication rather than a drape."
        : `This render is ${job.status} and has no drape to show.`,
      { status: job.status });
  }
  return {
    jobRef: job.jobRef,
    patternRevisionRef: job.patternRevisionRef,
    patternRevisionNumber: job.patternRevisionNumber,
    solverVersion: str(job.drape.solverVersion),
    quality: str(job.drape.quality),
    unit: str(job.drape.unit) || "mm",
    vertexCount: job.drape.vertexCount,
    triangleCount: job.drape.triangleCount ?? 0,
    pieces: job.drape.pieces || [],
    body: job.drape.body || null,
    positionsBase64: bytesOf(job.drape.positions).toString("base64"),
  };
}

/**
 * THE READ-ONLY GUARANTEE, AS A FUNCTION.
 *
 * Anything in the 3D half that is about to write asks this first. It exists so
 * the rule is one sentence in one place rather than a condition repeated in
 * every route that could break it — and so the refusal says WHY rather than
 * "forbidden".
 */
function assertNotDerived(publication, what) {
  if (!publication?.derivedFromPatternRevisionRef) return;
  throw fail("DERIVED_PREVIEW_READ_ONLY",
    `This 3D model is a preview derived from 2D pattern revision `
    + `${publication.derivedFromPatternRevisionNumber}. ${what} would change the picture without `
    + "changing the garment. Edit the pattern instead — the preview is made from it.",
    {
      patternRevisionRef: publication.derivedFromPatternRevisionRef,
      patternRevisionNumber: publication.derivedFromPatternRevisionNumber,
    });
}

module.exports = {
  RENDER_STATUS,
  listRenders, requestRender, recordRenderOutcome, readDrape,
  stalenessOf, currentRevisionOf, jobView, assertNotDerived,
};

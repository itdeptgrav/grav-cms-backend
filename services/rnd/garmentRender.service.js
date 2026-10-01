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
    },
    inputs: job.inputs || {},
    resultPublicationRef: str(job.resultPublicationRef),
    resultPublicationId: job.resultPublicationId ? String(job.resultPublicationId) : "",
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

/* ═══ WHAT THE ENGINE REPORTS BACK ════════════════════════════════════════
 *
 * Called by whatever adapter is connected — a webhook, a poller, a worker. It
 * is the only way a job leaves `simulating`, and it cannot move a job that has
 * already finished: a completed render is evidence, and a late callback must
 * not rewrite it.
 */
async function recordRenderOutcome(ctx, {
  jobRef, status, publicationId, publicationRef, failure, actor = null,
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
    if (!isId(publicationId)) {
      throw fail("VALIDATION",
        "A completed render has to name the model publication it produced.", { field: "publicationId" });
    }
    job.resultPublicationId = publicationId;
    job.resultPublicationRef = str(publicationRef);
    job.events.push({ kind: "completed", note: str(publicationRef), by: who, at });
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
  listRenders, requestRender, recordRenderOutcome,
  stalenessOf, currentRevisionOf, jobView, assertNotDerived,
};

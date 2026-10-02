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
        sewingLineSource: str(job.drape.sewingLineSource),
        seamAllowanceMm: job.drape.seamAllowanceMm ?? null,
        authoritative: job.drape.authoritative !== false,
        outcome: str(job.drape.outcome) || "fitting",
        withheld: job.drape.withheld || [],
        fabricGrade: str(job.drape.fabricGrade),
        settled: job.drape.settled === true,
        settledBelowMm: job.drape.settledBelowMm ?? null,
        convergence: str(job.drape.convergence),
        geometryIdentity: str(job.drape.geometryIdentity),
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
    /* ── IS ANYBODY STILL MAKING THIS? ─────────────────────────────────
       Computed, never stored: a stored "abandoned" flag would be wrong the
       moment a heartbeat arrived, and right only until the next one did not. */
    abandoned: abandoned(job),
    lease: {
      heartbeatAt: job.lease?.heartbeatAt || null,
      expiresAt: job.lease?.expiresAt || null,
      heldBy: str(job.lease?.heldBy?.name),
    },
    recovery: job.recovery?.recoveredAt
      ? {
        recoveredAt: job.recovery.recoveredAt,
        recoveredBy: str(job.recovery.recoveredBy?.name),
        reason: str(job.recovery.reason),
      }
      : null,
    /* What this render was accepted under — the sewing line it was entitled to
       use and the findings it was never allowed to report. */
    acceptedReadiness: job.acceptedReadiness || null,
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

/* ═══ LEASES, AND WHAT AN ABANDONED JOB IS ════════════════════════════════
 *
 * The solver runs in the reader's browser, so a closed tab, a crash or a laptop
 * lid ends the arithmetic with no message at all. Nothing distinguishes that from
 * a drape still in progress unless the job says when it was last alive — and the
 * first version of this record had no such field, so one closed tab blocked the
 * revision for ever: only one render may run at a time, and nothing would ever
 * finish that one.
 *
 * ── WHY A LEASE AND NOT A TIMEOUT ON THE JOB'S AGE ──────────────────────────
 * Because a High drape legitimately takes a minute and a slow laptop two, and a
 * fixed age limit either kills real work or waits so long it is useless. A
 * heartbeat answers the actual question — is anybody still solving this — and the
 * answer does not depend on how long the work ought to take.
 *
 * Ninety seconds. A run beats every fifteen, so three missed beats is already
 * conclusive, and somebody who closed a tab does not wait minutes to retry.
 */
const LEASE_MS = 90 * 1000;
const HEARTBEAT_MS = 15 * 1000;

/** Nobody is working on this: it holds a lease and the lease has run out. */
function abandoned(job, now = Date.now()) {
  if (![RENDER_STATUS.QUEUED, RENDER_STATUS.SIMULATING].includes(job.status)) return false;
  const expires = job.lease?.expiresAt ? new Date(job.lease.expiresAt).getTime() : 0;
  /* No lease at all means an engine elsewhere owns it, and its own supervision is
     not ours to second-guess. A QUEUED job that never reached an engine is the
     one exception: nothing is ever going to pick it up. */
  if (!expires) {
    if (job.status !== RENDER_STATUS.QUEUED) return false;
    const born = new Date(job.createdAt || 0).getTime();
    return born > 0 && now - born > LEASE_MS;
  }
  return now > expires;
}

/** Close an abandoned job down, keeping it in the history. */
async function reap(row, who, reason) {
  const job = row._id ? await RenderJob.findById(row._id) : row;
  if (!job) return null;
  if (![RENDER_STATUS.QUEUED, RENDER_STATUS.SIMULATING].includes(job.status)) return job;
  const at = new Date();
  job.status = RENDER_STATUS.CANCELLED;
  job.finishedAt = at;
  job.failure = {
    code: "DRAPE_ABANDONED",
    message: "This preview stopped reporting and was cleared. The browser making it was closed, "
      + "lost its connection, or crashed. Nothing about the pattern changed.",
  };
  job.recovery = { recoveredBy: who, recoveredAt: at, reason: str(reason) };
  job.lease = { runId: "", heartbeatAt: null, expiresAt: null };
  job.events.push({ kind: "cancelled", note: `abandoned — ${str(reason)}`, by: who, at });
  job.revision += 1;
  await job.save();
  return job;
}

/**
 * KEEP A RUNNING DRAPE'S LEASE ALIVE.
 *
 * Called by the page every few seconds while the solver works, and deliberately
 * the only thing that extends a lease: a job cannot be kept alive by anything
 * except something that is actually solving it.
 */
async function heartbeat(ctx, { jobRef, runId, actor = null } = {}) {
  assertContext(ctx);
  const job = await RenderJob.findOne({ companyId: ctx.companyId, jobRef: str(jobRef) });
  if (!job) throw fail("NOT_FOUND", "That render job was not found.");
  if (![RENDER_STATUS.QUEUED, RENDER_STATUS.SIMULATING].includes(job.status)) {
    /* Not an error. A heartbeat arriving a moment after the drape reported is
       ordinary, and answering it with a failure would make a page show one. */
    return { jobRef: job.jobRef, status: job.status, holding: false };
  }
  /* ── A SECOND TAB DOES NOT GET TO TAKE OVER ────────────────────────────
     Once a run id holds the lease, only that run id may renew it. Otherwise two
     tabs each believe they own the drape, both report, and the second is refused
     after a minute of work it did not need to do. */
  const holder = str(job.lease?.runId);
  const mine = str(runId);
  if (holder && mine && holder !== mine && !abandoned(job)) {
    throw fail("RENDER_ALREADY_RUNNING",
      "Another browser is already making this preview.",
      { jobRef: job.jobRef, holder });
  }
  const at = new Date();
  /* ── RENEW IN PLACE, DO NOT REBUILD ─────────────────────────────────────
     Replacing the whole `lease` object meant re-supplying `heldBy`, and a job whose
     lease was created without one — any path where the holder was never recorded —
     then had `undefined` assigned to a nested path and Mongoose refused the save
     with a cast error. A heartbeat failing on the job it is keeping alive is the
     one thing this call must never do, so it sets only the fields a renewal
     actually changes and leaves the holder alone. */
  job.lease.runId = mine || holder;
  job.lease.heartbeatAt = at;
  job.lease.expiresAt = new Date(at.getTime() + LEASE_MS);
  if (!str(job.lease.heldBy?.id) && !str(job.lease.heldBy?.name)) {
    job.lease.heldBy = actorOf(actor);
  }
  await job.save();
  return {
    jobRef: job.jobRef,
    status: job.status,
    holding: true,
    expiresAt: job.lease.expiresAt,
    heartbeatMs: HEARTBEAT_MS,
  };
}

/**
 * CLEAR AN ABANDONED DRAPE SO THE REVISION CAN BE TRIED AGAIN.
 *
 * Refuses a job that is still beating. "Clear" is for work nobody is doing, and a
 * control that could kill a colleague's running drape is a different control with
 * a different confirmation.
 */
async function recoverAbandoned(ctx, { jobRef, actor = null } = {}) {
  assertContext(ctx);
  const job = await RenderJob.findOne({ companyId: ctx.companyId, jobRef: str(jobRef) }).lean();
  if (!job) throw fail("NOT_FOUND", "That render job was not found.");
  if (![RENDER_STATUS.QUEUED, RENDER_STATUS.SIMULATING].includes(job.status)) {
    throw fail("INVALID_TRANSITION",
      `This render has already ${job.status}. There is nothing to clear.`, { status: job.status });
  }
  if (!abandoned(job)) {
    const seconds = job.lease?.heartbeatAt
      ? Math.round((Date.now() - new Date(job.lease.heartbeatAt).getTime()) / 1000)
      : null;
    throw fail("RENDER_STILL_RUNNING",
      "This preview is still being made"
      + (seconds !== null
        ? ` — it last reported ${seconds} second${seconds === 1 ? "" : "s"} ago`
        : "")
      + ". Stop it from the browser that is making it, rather than clearing it here.",
      { jobRef: job.jobRef, heartbeatAt: job.lease?.heartbeatAt || null });
  }
  const closed = await reap(job, actorOf(actor), "cleared by hand after its browser stopped reporting");
  const context = await currentRevisionOf(ctx, closed.styleId);
  return { render: jobView(closed, context) };
}

/**
 * Every abandoned job on a style, for the surface that offers to clear them.
 *
 * Read-only: finding them must not close them, because a list that reaped as a
 * side effect of being looked at could not be looked at twice.
 */
async function listAbandoned(ctx, { styleId } = {}) {
  assertContext(ctx);
  const style = await styleForCompany(ctx.companyId, styleId);
  const jobs = await RenderJob.find({
    companyId: ctx.companyId,
    styleId: style._id,
    status: { $in: [RENDER_STATUS.QUEUED, RENDER_STATUS.SIMULATING] },
  }).lean();
  const context = await currentRevisionOf(ctx, style._id);
  return { abandoned: jobs.filter((j) => abandoned(j)).map((j) => jobView(j, context)) };
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

  const readiness = simulation.checkInputs(revision.patternSet, revision.simulationInputs, {
    revisionRef: revision.revisionRef,
    mappingConfirmedAgainstRef: revision.mappingConfirmedAgainstRef,
  });
  if (!readiness.ready) {
    /* The failure's own sentence, not a list of step names. "Seam mapping is
       missing" sends somebody hunting; "the left armhole does not say which end
       meets which" does not. */
    const first = readiness.failures[0];
    throw fail("SIMULATION_INPUTS_MISSING",
      readiness.failures.length === 1
        ? first.message
        : `This pattern cannot be draped yet. ${first.message} `
          + `(${readiness.failures.length - 1} other thing`
          + `${readiness.failures.length === 2 ? "" : "s"} still needed.)`,
      { missing: readiness.missing, failures: readiness.failures, readiness });
  }

  /* ── ONE RUN AT A TIME, AND AN ABANDONED ONE IS NOT A RUN ─────────────
     Two solvers racing on the same pattern produce two garments and no way to say
     which is the preview. But the first version of this check counted a job whose
     tab had been closed, so one closed laptop lid blocked the revision for ever
     with no way to clear it. A lease that has expired means nobody is working. */
  const running = await RenderJob.findOne({
    companyId: ctx.companyId,
    patternRevisionId: revision._id,
    status: { $in: [RENDER_STATUS.QUEUED, RENDER_STATUS.SIMULATING] },
  }).lean();
  if (running && !abandoned(running)) {
    throw fail("RENDER_ALREADY_RUNNING",
      `A preview of pattern revision ${revision.revisionNumber} is already being made.`,
      { jobRef: running.jobRef, status: running.status });
  }
  if (running) {
    /* Closed down rather than ignored, so the history says what happened to it
       and the list does not grow a column of jobs nothing will ever finish. */
    await reap(running, actorOf(actor), "superseded by a new request");
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
    /* What the pattern was judged ready on, as it stood. A fitting is evidence,
       and evidence that cannot say what it assumed is weak evidence. */
    acceptedReadiness: {
      outcome: readiness.outcome,
      sewingLineSource: readiness.sewingLine.source,
      authoritative: readiness.sewingLine.authoritative,
      seamAllowanceMm: readiness.sewingLine.allowanceMm,
      fabricGrade: readiness.fabric.grade,
      withheld: readiness.withheld,
      warnings: readiness.warnings.map((w) => ({ code: w.code, message: w.message })),
      notes: readiness.notes,
    },
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
    /* A browser-run job holds a lease and beats a heartbeat while it solves. An
       engine somewhere else does not: it has its own supervision, and a lease we
       could not renew on its behalf would expire mid-render. */
    if (simulation.runsInBrowser()) {
      job.lease = {
        runId: "",
        heldBy: who,
        heartbeatAt: at,
        expiresAt: new Date(at.getTime() + LEASE_MS),
      };
    }
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
  /* ── A DRAPE MUST SAY WHICH SEWING LINE IT SEWED ON ────────────────────
     Not optional, and not defaulted to "published". A drape sewn on the cut
     boundary is not a drape with a small offset on it: the panels meet in the
     wrong places. A drape that could not say which line it used would be a drape
     whose numbers nobody can qualify, and the screens would show them anyway. */
  /* ── THE GEOMETRY FINGERPRINT IS NOT OPTIONAL ───────────────────────────
     Reopening a drape means drawing stored positions through faces rebuilt now.
     A point COUNT is not evidence those faces are the same ones: two revisions
     that differ by a moved point mesh to the same number of points, and the
     stored positions would then be drawn through a garment that is neither. The
     fingerprint is what makes the rebuild provable, so a drape that does not
     carry one is refused rather than stored and trusted later. */
  if (!str(drape.geometryIdentity)) {
    throw fail("VALIDATION",
      "That drape does not carry a geometry fingerprint, so reopening it could never be proven "
      + "to rebuild the same mesh. It was not stored.",
      { field: "drape.geometryIdentity" });
  }
  const sewingLineSource = str(drape.sewingLineSource);
  if (!["published", "derived", "cut-boundary"].includes(sewingLineSource)) {
    throw fail("VALIDATION",
      "That drape does not say whether it was sewn on a published sewing line, a derived one, or "
      + "the cut boundary. Every dimensional finding depends on which, so it was not stored.",
      { field: "drape.sewingLineSource" });
  }
  const authoritative = sewingLineSource !== "cut-boundary" && drape.authoritative !== false;
  const withheld = (Array.isArray(drape.withheld) ? drape.withheld : [])
    .filter((w) => str(w?.finding) && str(w?.why))
    .map((w) => ({ finding: str(w.finding), why: str(w.why) }));
  if (!authoritative && !withheld.length) {
    throw fail("VALIDATION",
      "That drape was sewn on the cut boundary and withholds nothing. Every dimensional finding "
      + "is biased by the unstated allowance, so a drape claiming otherwise was not stored.",
      { field: "drape.withheld" });
  }

  return {
    solverVersion: str(drape.solverVersion),
    quality: str(drape.quality),
    sewingLineSource,
    seamAllowanceMm: Number.isFinite(Number(drape.seamAllowanceMm))
      ? Number(drape.seamAllowanceMm) : null,
    authoritative,
    withheld,
    outcome: withheld.length ? "partial" : "fitting",
    readiness: drape.readiness || null,
    fabricGrade: str(drape.fabricGrade),
    settled: drape.settled === true,
    settledBelowMm: Number.isFinite(Number(drape.settledBelowMm))
      ? Number(drape.settledBelowMm) : null,
    convergence: str(drape.convergence)
      || (drape.settled === true ? "settled" : "preview not fully settled"),
    /* The fingerprint of the geometry this drape was built from, so a later
       rebuild can be PROVEN to be the same mesh rather than assumed. */
    geometryIdentity: str(drape.geometryIdentity),
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
  /* ── THE DRAPE'S OWN REVISION, NOT THE ONE SOMEBODY HAS SELECTED ──────
     The triangles are rebuilt rather than stored, and a rebuild is only honest
     against the pattern the drape was MADE from. Reading them from whichever
     revision happens to be open on screen would draw one revision's positions
     through another revision's faces: a garment that is neither, labelled as
     one of them. So the pattern travels with the drape. */
  const revision = await PatternRevision
    .findOne({ _id: job.patternRevisionId, companyId: ctx.companyId })
    .select("revisionRef revisionNumber state patternSet simulationInputs")
    .lean();
  if (!revision) {
    throw fail("NO_DRAPE",
      `This drape was made from pattern revision ${job.patternRevisionNumber}, which is no longer `
      + "in the record, so its geometry cannot be rebuilt. The findings it reported are still "
      + "readable.",
      { patternRevisionRef: job.patternRevisionRef });
  }

  return {
    jobRef: job.jobRef,
    patternRevisionRef: job.patternRevisionRef,
    patternRevisionNumber: job.patternRevisionNumber,
    patternRevisionId: String(job.patternRevisionId),
    solverVersion: str(job.drape.solverVersion),
    quality: str(job.drape.quality),
    unit: str(job.drape.unit) || "mm",
    vertexCount: job.drape.vertexCount,
    triangleCount: job.drape.triangleCount ?? 0,
    pieces: job.drape.pieces || [],
    body: job.drape.body || null,
    sewingLineSource: str(job.drape.sewingLineSource),
    seamAllowanceMm: job.drape.seamAllowanceMm ?? null,
    authoritative: job.drape.authoritative !== false,
    withheld: job.drape.withheld || [],
    geometryIdentity: str(job.drape.geometryIdentity),
    /* Everything needed to rebuild the faces, from the revision the drape names.
       `inputs` is the job's frozen copy, not the revision's current settings:
       the seam map may have been edited since, and the mesh depends on it. */
    patternSet: revision.patternSet || null,
    inputs: job.inputs || {},
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
  heartbeat, recoverAbandoned, listAbandoned, abandoned, LEASE_MS, HEARTBEAT_MS,
  stalenessOf, currentRevisionOf, jobView, assertNotDerived,
};

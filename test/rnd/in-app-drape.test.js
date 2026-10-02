// test/rnd/in-app-drape.test.js
//
// THE DRAPE THAT THIS REPOSITORY COMPUTES ITSELF.
//
// The cloth solver runs in the reader's browser (`grav-cms/components/rnd/fit/`)
// and is tested there. What is tested HERE is the half the server owns, and the
// server owns the part that has to survive a closed tab:
//
//   · the job is minted, moved to `simulating` and only ever finished by a
//     reported outcome, so an abandoned drape is a job that never reported —
//     visible and clearable — rather than a preview that silently never was;
//   · a drape is NOT a publication, and cannot be filed as one;
//   · a drape whose geometry does not match its own piece table is refused,
//     because the piece names are the whole value of it;
//   · reporting a drape needs the privilege to ask for one, and no more. A model
//     publication is a file a sample gets approved against; a drape is a derived,
//     read-only reading of a pattern, and requiring publish rights to report one
//     would restrict the wrong act.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const mongoose = require("mongoose");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const SalesJourney = require("../../models/CMS_Models/Sales/SalesJourney");
const Account = require("../../models/CMS_Models/Sales/Account");
const SampleStyle = require("../../models/CMS_Models/Sales/SampleStyle");
const { RenderJob, RENDER_STATUS } = require("../../models/CMS_Models/RnD/PatternRevision");

const patterns = require("../../services/rnd/patternRevision.service");
const renders = require("../../services/rnd/garmentRender.service");
const simulation = require("../../services/rnd/simulationAdapter.service");
const tee = require("./fixtures/renderableTee");

let seq = 0;

async function world() {
  const n = ++seq;
  const co = await Acc_Company.create({
    companyName: `Drape Co ${n}`, booksFromDate: new Date("2026-04-01"),
  });
  const account = await Account.create({ companyName: `Buyer ${n}`, status: "active" });
  const journey = await SalesJourney.create({
    journeyId: `SJ-DR-${n}`, companyId: co._id, name: `J${n}`,
    accountId: account._id, ownerId: new mongoose.Types.ObjectId(), ownerName: "O",
  });
  const style = await SampleStyle.create({
    sampleStyleId: `SS-DR-${n}`, styleCode: `SC-DR-${n}`, productName: "Tunic",
    journeyId: journey._id, accountId: account._id, stage: "rnd",
    techSheet: { status: "pending" },
  });
  return {
    co, style, ctx: { companyId: co._id },
    actor: { id: `d${n}`, name: "A Patternmaker", email: `draft${n}@grav.test` },
  };
}

/* Two panels with eight corners each, so a seam can name part of an edge. */
/* ── THE FIXTURE IS SHARED, NOT COPIED ──────────────────────────────────────
   This suite used to carry its own two-panel tunic and its own `seamPairings`
   inputs. Both predate the readiness contract: `seamPairings` is not a field any
   more, and a two-panel tunic has no sleeves, so the template refuses it. The
   copy is gone and `fixtures/renderableTee` is the one definition — the same one
   the readiness suite uses, so the two cannot drift apart again. */
const patternSet = tee.patternSet;
const INPUTS = tee.simulationInputs();

async function renderable(w) {
  const imported = (await patterns.importRevision(w.ctx, {
    styleId: w.style._id,
    patternSet: patternSet(),
    sourceDxf: { driveFileId: "drv-1", name: "tunic.dxf", sha256: "a".repeat(64), bytes: 2048 },
    name: "Imported from CAD",
    actor: w.actor,
  })).revision;
  return (await patterns.setSimulationInputs(w.ctx, {
    revisionId: imported.id, inputs: INPUTS, actor: w.actor,
  })).revision;
}

/** A plausible drape, as the browser sends it: positions as base64 Float32. */
function drapeFor({ vertexCount = 12, pieces = null } = {}) {
  const positions = new Float32Array(vertexCount * 3);
  for (let i = 0; i < vertexCount; i += 1) {
    positions[i * 3] = i * 10;
    positions[i * 3 + 1] = 1200 + i;
    positions[i * 3 + 2] = 40;
  }
  return {
    solverVersion: "fit-1.0",
    quality: "normal",
    /* Which line it was sewn on. Every dimensional finding depends on it, so a
       drape that does not say is refused rather than stored and guessed at. */
    sewingLineSource: "derived",
    authoritative: true,
    seamAllowanceMm: 10,
    withheld: [],
    /* The fingerprint of the mesh this drape was built from, so reopening it can
       be PROVEN to be the same geometry rather than assumed from a point count. */
    geometryIdentity: "tee-4-piece-normal-fit-1.0",
    fabric: { id: "poplin", label: "Cotton poplin (shirting)", version: "1" },
    unit: "mm",
    vertexCount,
    triangleCount: 6,
    /* FOUR pieces, because the fixture tee has four and a drape must account for
       every point: front, back and two sleeves. `vertexCount` is divided evenly,
       so callers pass a multiple of four. */
    pieces: pieces || [
      { pieceRef: "PC-FRONT", name: "Front", role: "body.front", base: 0, vertexCount: vertexCount / 4 },
      { pieceRef: "PC-BACK", name: "Back", role: "body.back", base: vertexCount / 4, vertexCount: vertexCount / 4 },
      { pieceRef: "PC-SLV-L", name: "Sleeve Left", role: "sleeve", base: (vertexCount / 4) * 2, vertexCount: vertexCount / 4 },
      { pieceRef: "PC-SLV-R", name: "Sleeve Right", role: "sleeve", base: (vertexCount / 4) * 3, vertexCount: vertexCount / 4 },
    ],
    positions: Buffer.from(positions.buffer).toString("base64"),
    seamClosure: [
      { name: "Right side seam", worstGapMm: 8.4, meanGapMm: 1.2, sourceLengthMm: 471.2, stations: 27 },
    ],
    strain: { maxPercent: 11.0, meanPercent: 0.4 },
    fidelity: { ok: true, worstBoundaryMm: 0, worstSeamMm: 0 },
    tightestClearanceMm: 1.9,
    template: { id: "tshirt", label: "Basic T-shirt", confidence: 1 },
    body: { kind: "capsules", estimated: true },
    frames: 534,
    finalMoveMm: 0.42,
    msElapsed: 10240,
  };
}

const withAdapter = async (fn) => {
  process.env.RND_SIMULATION_ADAPTER = "in-app";
  try { return await fn(); } finally { delete process.env.RND_SIMULATION_ADAPTER; }
};

const refuses = async (fn, code) => {
  try { await fn(); } catch (err) { expect(err.code).toBe(code); return err; }
  throw new Error(`expected a ${code} refusal and nothing was refused`);
};

/* ═══ 1 · THE ADAPTER ═════════════════════════════════════════════════════ */

describe("the in-app solver is an adapter like any other", () => {
  test("it is registered, and selected by the same environment variable", () => {
    expect(simulation.__adapters.has("in-app")).toBe(true);
    const off = simulation.adapterStatus();
    expect(off.configured).toBe(false);
    return withAdapter(async () => {
      const on = simulation.adapterStatus();
      expect(on.configured).toBe(true);
      expect(on.name).toBe("in-app");
      expect(on.runsInBrowser).toBe(true);
      /* And it says what it is NOT, in the sentence a screen shows. */
      expect(on.message).toMatch(/in this browser/);
      expect(on.message).toMatch(/not a replacement for a production drape in CLO/);
    });
  });

  test("with no engine configured, a render still fails with a sentence", async () => {
    const w = await world();
    const ready = await renderable(w);
    const out = await renders.requestRender(w.ctx, { revisionId: ready.id, actor: w.actor });
    expect(out.render.status).toBe(RENDER_STATUS.FAILED);
    expect(out.render.failure.code).toBe("SIMULATION_ENGINE_NOT_CONNECTED");
    expect(out.render.engine.runsInBrowser).toBe(false);
  });

  /* ── WHERE A MISSING SEAM IS REFUSED ────────────────────────────────────
     Not here. The adapter refuses only what an adapter is entitled to refuse — a
     request it cannot physically act on — and readiness refuses the rest before a
     job is minted. An adapter re-deciding readiness with its own shorter list is
     how the screen and the server came to disagree. */
  test("it refuses a pattern with no outline to sew, which is all it may judge", async () => {
    return withAdapter(async () => {
      await expect(simulation.submit({
        jobRef: "RJ-1", patternSet: { pieces: [] }, inputs: {},
      })).resolves.toMatchObject({ status: "failed" });
    });
  });

  test("it accepts a job and names itself, leaving readiness to the render service", async () => {
    await expect(simulation.submit({
      jobRef: "RJ-1", patternSet: patternSet(), inputs: { seams: [] },
    })).resolves.toMatchObject({ status: "unavailable" });
    return withAdapter(async () => {
      const out = await simulation.submit({
        jobRef: "RJ-1", patternSet: patternSet(), inputs: { seams: [] },
      });
      expect(out.status).toBe("accepted");
      expect(out.version).toBe(require("../../services/rnd/adapters/inAppSolver.adapter")
        .SOLVER_VERSION);
    });
  });
});

/* ═══ 2 · READINESS NAMES WHAT IS STILL MISSING ═══════════════════════════ */

describe("readiness names what is still missing", () => {
  /* These four used to assert on `check.seamMapping`, which the readiness
     contract replaced with named steps and coded failures. The intent is the
     same and the shape is not: a seam now names RUNS on each side, so "names two
     pieces but not two edges" is "names a run that does not exist". */

  test("a seam naming a run that does not exist is a failure, not a silent skip", () => {
    const check = simulation.checkInputs(patternSet(), tee.simulationInputs({
      seams: [tee.seam("S-BAD", "Side", [tee.at("PC-FRONT", "no-such-run")],
        [tee.at("PC-BACK", "side-l")])],
    }));
    expect(check.ready).toBe(false);
    expect(check.failures.some((f) => f.step === "seams")).toBe(true);
    expect(check.missing.map((m) => m.key)).toContain("seams");
  });

  test("a seam naming a piece that is not in the pattern says which piece", () => {
    const check = simulation.checkInputs(patternSet(), tee.simulationInputs({
      seams: [tee.seam("S-COLLAR", "Collar join", [tee.at("PC-FRONT", "shoulder-r")],
        [tee.at("PC-COLLAR", "join")])],
    }));
    expect(check.ready).toBe(false);
    expect(JSON.stringify(check.failures)).toMatch(/PC-COLLAR/);
  });

  test("a piece whose perimeter is not covered is named, and the fix is one confirmation", () => {
    const plans = tee.simulationInputs().pieces.map((plan) => ({
      ...plan,
      boundaryConfirmed: plan.pieceRef === "PC-SLV-L" ? null : plan.boundaryConfirmed,
    }));
    const check = simulation.checkInputs(patternSet(), tee.simulationInputs({ pieces: plans }));
    const boundary = check.failures.filter((f) => f.step === "boundary");
    expect(boundary).toHaveLength(1);
    expect(boundary[0].code).toBe("R5");
    expect(boundary[0].pieces.map((x) => x.pieceRef)).toContain("PC-SLV-L");
  });

  test("a fully described pattern is ready, with nothing missing", () => {
    const check = simulation.checkInputs(patternSet(), INPUTS);
    expect(check.ready).toBe(true);
    expect(check.missing).toEqual([]);
    expect(check.pieceCount).toBe(4);
    /* The default fixture has no neck finish on purpose, so it is READY and
       PARTIAL at the same time — the §6.4 case, and the one a screen must not
       label "everything is ready". */
    expect(check.outcome).toBe("partial");
    expect(check.withheld.map((w) => w.finding)).toContain("collar");
  });

  test("with a neck band it is ready and complete, and nothing is withheld for the neck", () => {
    const check = simulation.checkInputs(
      patternSet({ withNeckBand: true }),
      tee.simulationInputs({ withNeckBand: true }),
    );
    expect(check.ready).toBe(true);
    expect(check.withheld.map((w) => w.finding)).not.toContain("collar");
  });
});

/* ═══ 3 · THE JOB THE SERVER OWNS ════════════════════════════════════════ */

describe("the job is the server's, whoever does the arithmetic", () => {
  async function simulating(w) {
    const ready = await renderable(w);
    return withAdapter(async () => {
      const out = await renders.requestRender(w.ctx, { revisionId: ready.id, actor: w.actor });
      return { ready, job: out.render };
    });
  }

  test("requesting a render accepts the job and tells the page it owns the drape", async () => {
    const w = await world();
    const { job } = await simulating(w);
    expect(job.status).toBe(RENDER_STATUS.SIMULATING);
    expect(job.engine.adapter).toBe("in-app");
    expect(job.engine.version).toBe("fit-1.0");
    /* Its own id IS the job ref: there is no second system holding a second id. */
    expect(job.engine.externalJobId).toBe(job.jobRef);
    expect(job.engine.runsInBrowser).toBe(true);
    expect(job.drape).toEqual({ present: false });
    /* And the inputs were copied, so editing the revision cannot change what
       this garment was draped with. */
    expect(job.inputs.seams).toHaveLength(INPUTS.seams.length);
  });

  test("a drape completes the job and is stored with what it found", async () => {
    const w = await world();
    const { job } = await simulating(w);
    const out = await renders.recordRenderOutcome(w.ctx, {
      jobRef: job.jobRef, status: "completed", drape: drapeFor(), actor: w.actor,
    });
    expect(out.render.status).toBe(RENDER_STATUS.COMPLETED);
    expect(out.render.drape.present).toBe(true);
    expect(out.render.drape.vertexCount).toBe(12);
    expect(out.render.drape.quality).toBe("normal");
    expect(out.render.drape.solverVersion).toBe("fit-1.0");
    expect(out.render.drape.unit).toBe("mm");
    expect(out.render.drape.seamClosure[0].worstGapMm).toBeCloseTo(8.4, 5);
    expect(out.render.drape.strain.maxPercent).toBeCloseTo(11.0, 5);
    /* The sentence that stops it being approved against. */
    expect(out.render.drape.caveat).toMatch(/should not be approved against it/);
    expect(out.render.readOnly).toBe(true);
    expect(out.render.derivedFrom).toBe("Derived from 2D pattern revision 1.");
    /* A DRAPE IS NOT A PUBLICATION. */
    expect(out.render.resultPublicationRef).toBe("");
    expect(out.render.resultPublicationId).toBe("");
  });

  test("the job list does not carry the geometry; reading the drape does", async () => {
    const w = await world();
    const { job } = await simulating(w);
    await renders.recordRenderOutcome(w.ctx, {
      jobRef: job.jobRef, status: "completed", drape: drapeFor({ vertexCount: 12 }), actor: w.actor,
    });
    const list = await renders.listRenders(w.ctx, { styleId: w.style._id });
    expect(list.current.drape.present).toBe(true);
    expect(list.current.drape.positions).toBeUndefined();
    expect(list.current.drape.positionsBase64).toBeUndefined();

    const read = await renders.readDrape(w.ctx, { jobRef: job.jobRef });
    expect(read.vertexCount).toBe(12);
    expect(read.unit).toBe("mm");
    expect(read.patternRevisionNumber).toBe(1);
    expect(read.pieces.map((p) => p.pieceRef))
      .toEqual(["PC-FRONT", "PC-BACK", "PC-SLV-L", "PC-SLV-R"]);
    const bytes = Buffer.from(read.positionsBase64, "base64");
    expect(bytes.length).toBe(12 * 3 * 4);
    const positions = new Float32Array(bytes.buffer, bytes.byteOffset, 36);
    expect(positions[0]).toBeCloseTo(0, 5);
    expect(positions[4]).toBeCloseTo(1201, 5);
  });

  test("a drape whose positions do not match its vertex count is refused", async () => {
    /* The labels are the whole value: a reader looking at a strained area has to
       be told which PATTERN PIECE it is on. */
    const w = await world();
    const { job } = await simulating(w);
    const bad = drapeFor({ vertexCount: 12 });
    bad.vertexCount = 20;
    const err = await refuses(() => renders.recordRenderOutcome(w.ctx, {
      jobRef: job.jobRef, status: "completed", drape: bad, actor: w.actor,
    }), "VALIDATION");
    expect(err.message).toMatch(/cannot say which panel/);
    /* And the job is untouched, still waiting. */
    const still = await RenderJob.findOne({ jobRef: job.jobRef }).lean();
    expect(still.status).toBe(RENDER_STATUS.SIMULATING);
  });

  test("a drape whose pieces do not account for every point is refused", async () => {
    const w = await world();
    const { job } = await simulating(w);
    const bad = drapeFor({
      vertexCount: 12,
      pieces: [{ pieceRef: "PC-FRONT", name: "Front Panel", base: 0, vertexCount: 6 }],
    });
    const err = await refuses(() => renders.recordRenderOutcome(w.ctx, {
      jobRef: job.jobRef, status: "completed", drape: bad, actor: w.actor,
    }), "VALIDATION");
    expect(err.message).toMatch(/account for 6 of its 12/);
  });

  test("a completed render that names neither a publication nor a drape is refused", async () => {
    const w = await world();
    const { job } = await simulating(w);
    await refuses(() => renders.recordRenderOutcome(w.ctx, {
      jobRef: job.jobRef, status: "completed", actor: w.actor,
    }), "VALIDATION");
  });

  test("a drape that could not finish is recorded as a failure with its reason", async () => {
    const w = await world();
    const { job } = await simulating(w);
    const out = await renders.recordRenderOutcome(w.ctx, {
      jobRef: job.jobRef, status: "failed",
      failure: {
        code: "GEOMETRY_FIDELITY_FAILED",
        message: "This simulation was stopped because the mesh does not match the pattern.",
      },
      actor: w.actor,
    });
    expect(out.render.status).toBe(RENDER_STATUS.FAILED);
    expect(out.render.failure.code).toBe("GEOMETRY_FIDELITY_FAILED");
    expect(out.render.drape).toEqual({ present: false });
  });

  test("a closed tab leaves a job that never reported, not a phantom preview", async () => {
    /* The reason the record is the server's. Nothing finishes this job but a
       reported outcome, so it stays visibly `simulating` instead of becoming a
       preview that does not exist. */
    const w = await world();
    const { job } = await simulating(w);
    const list = await renders.listRenders(w.ctx, { styleId: w.style._id });
    /* `current` is the latest COMPLETED render, so there is still none — the 3D
       side has nothing to show, which is the truth. The job is there, visible,
       and stuck at `simulating` until something reports. */
    expect(list.current).toBeNull();
    expect(list.renders[0].jobRef).toBe(job.jobRef);
    expect(list.renders[0].status).toBe(RENDER_STATUS.SIMULATING);
    expect(list.renders[0].drape.present).toBe(false);
  });

  test("a late drape cannot rewrite a render that has already finished", async () => {
    const w = await world();
    const { job } = await simulating(w);
    await renders.recordRenderOutcome(w.ctx, {
      jobRef: job.jobRef, status: "completed", drape: drapeFor(), actor: w.actor,
    });
    await refuses(() => renders.recordRenderOutcome(w.ctx, {
      jobRef: job.jobRef, status: "completed", drape: drapeFor({ vertexCount: 24 }), actor: w.actor,
    }), "INVALID_TRANSITION");
  });

  test("reading a drape from a render that has none says which it is", async () => {
    const w = await world();
    const { job } = await simulating(w);
    const err = await refuses(() => renders.readDrape(w.ctx, { jobRef: job.jobRef }), "NO_DRAPE");
    expect(err.message).toMatch(/simulating/);
  });

  test("one drape at a time per revision", async () => {
    const w = await world();
    const { ready } = await simulating(w);
    await withAdapter(() => refuses(
      () => renders.requestRender(w.ctx, { revisionId: ready.id, actor: w.actor }),
      "RENDER_ALREADY_RUNNING",
    ));
  });

  test("another company cannot read or finish this drape", async () => {
    const w = await world();
    const other = await world();
    const { job } = await simulating(w);
    await refuses(() => renders.readDrape(other.ctx, { jobRef: job.jobRef }), "NOT_FOUND");
    await refuses(() => renders.recordRenderOutcome(other.ctx, {
      jobRef: job.jobRef, status: "completed", drape: drapeFor(), actor: other.actor,
    }), "NOT_FOUND");
  });
});

/* ═══ 4 · AND THE PATTERN IS STILL THE PATTERN ═══════════════════════════ */

describe("a drape changes nothing about the pattern it was made from", () => {
  test("the revision is byte-identical after a drape is recorded", async () => {
    const w = await world();
    const ready = await renderable(w);
    const before = await patterns.readRevision(w.ctx, { revisionId: ready.id });
    const job = (await withAdapter(
      () => renders.requestRender(w.ctx, { revisionId: ready.id, actor: w.actor }),
    )).render;
    await renders.recordRenderOutcome(w.ctx, {
      jobRef: job.jobRef, status: "completed", drape: drapeFor(), actor: w.actor,
    });
    const after = await patterns.readRevision(w.ctx, { revisionId: ready.id });
    expect(JSON.stringify(after.revision.patternSet))
      .toBe(JSON.stringify(before.revision.patternSet));
    expect(after.revision.revisionNumber).toBe(before.revision.revisionNumber);
    expect(after.revision.state).toBe(before.revision.state);
  });

  test("a drape goes out of date when the pattern moves on, and is not deleted", async () => {
    const w = await world();
    const ready = await renderable(w);
    const job = (await withAdapter(
      () => renders.requestRender(w.ctx, { revisionId: ready.id, actor: w.actor }),
    )).render;
    await renders.recordRenderOutcome(w.ctx, {
      jobRef: job.jobRef, status: "completed", drape: drapeFor(), actor: w.actor,
    });
    await patterns.editRevision(w.ctx, {
      revisionId: ready.id,
      operations: [{ kind: "seam-allowance", pieceRef: "PC-FRONT", seamAllowance: 14 }],
      actor: w.actor,
    });
    const list = await renders.listRenders(w.ctx, { styleId: w.style._id });
    expect(list.outOfDate).toBe(true);
    expect(list.current.stale).toBe(true);
    /* Still there, still readable, still labelled with the revision it is of. */
    expect(list.current.drape.present).toBe(true);
    const read = await renders.readDrape(w.ctx, { jobRef: job.jobRef });
    expect(read.patternRevisionNumber).toBe(1);
  });
});

/* ═══ 5 · THE THREE THINGS QA FOUND ═══════════════════════════════════════ */

describe("what a screen cannot be allowed to get wrong", () => {
  test("THE SEAM MAP SURVIVES A SAVE AND A RELOAD", async () => {
    /* The failure this pins was total and silent. The screen posted its map as
       `simulationInputs.seamPairings`; the record had moved to `seams`; Mongoose
       strips undeclared paths without complaining. The save returned success and
       nothing was stored, so Generate 3D then refused because no seam had been
       mapped. A round trip is the only honest confirmation. */
    const w = await world();
    const ready = await renderable(w);

    const fresh = await patterns.readRevision(w.ctx, { revisionId: ready.id });
    const held = fresh.revision.simulationInputs;

    expect(held.seams).toHaveLength(INPUTS.seams.length);
    expect(held.seams.map((s) => s.seamId).sort()).toEqual(INPUTS.seams.map((s) => s.seamId).sort());
    for (const sent of INPUTS.seams) {
      const kept = held.seams.find((s) => s.seamId === sent.seamId);
      expect(kept.sideA.map((e) => e.runId)).toEqual(sent.sideA.map((e) => e.runId));
      expect(kept.sideB.map((e) => e.runId)).toEqual(sent.sideB.map((e) => e.runId));
      expect(kept.alignment).toBe(sent.alignment);
      /* And the confirmation carries a time the SERVER stamped: a confirmation
         nobody is attributable for is a guess. */
      expect(kept.alignmentConfirmed?.at).toBeTruthy();
    }
    /* The piece plans too — losing only the grain or only the boundary
       confirmation is the partial save hardest to notice. */
    expect(held.pieces).toHaveLength(INPUTS.pieces.length);
    for (const sent of INPUTS.pieces) {
      const kept = held.pieces.find((p) => p.pieceRef === sent.pieceRef);
      expect(kept.role).toBe(sent.role);
      expect(kept.grainVector).toEqual(sent.grainVector);
      expect(kept.boundaryConfirmed?.at).toBeTruthy();
    }
    /* `seamPairings` is not a field any more, and a save must not resurrect it. */
    expect(held.seamPairings).toBeUndefined();
  });

  test("A FIELD THE RECORD DOES NOT DECLARE IS NOT SILENTLY ACCEPTED", async () => {
    /* The screen's own guard reads the record back and compares. This proves the
       thing it compares against: posting the obsolete field stores nothing, so a
       screen that trusted its 200 would be lying. */
    const w = await world();
    const ready = await renderable(w);
    await patterns.setSimulationInputs(w.ctx, {
      revisionId: ready.id,
      inputs: { ...INPUTS, seams: [], seamPairings: INPUTS.seams },
      actor: w.actor,
    });
    const after = await patterns.readRevision(w.ctx, { revisionId: ready.id });
    expect(after.revision.simulationInputs.seams).toHaveLength(0);
    expect(after.revision.simulationInputs.seamPairings).toBeUndefined();
    /* And readiness says so, rather than the screen claiming a saved map. */
    expect(after.revision.readiness.ready).toBe(false);
    expect(after.revision.readiness.failures.some((f) => f.step === "seams")).toBe(true);
  });

  test("A STORED DRAPE CANNOT OPEN AGAINST ANOTHER REVISION WITH THE SAME POINT COUNT", async () => {
    /* A point COUNT is not evidence the faces are the same: two revisions that
       differ by a MOVED point mesh to the same number of points, and the stored
       positions would then be drawn through a garment that is neither. So a drape
       must carry a geometry fingerprint, and one that does not is refused at the
       door rather than trusted when it is reopened. */
    const w = await world();
    const ready = await renderable(w);
    const job = (await withAdapter(() => renders.requestRender(w.ctx, {
      revisionId: ready.id, actor: w.actor,
    }))).render;

    await expect(renders.recordRenderOutcome(w.ctx, {
      jobRef: job.jobRef,
      status: "completed",
      drape: { ...drapeFor({ vertexCount: 12 }), geometryIdentity: "" },
      actor: w.actor,
    })).rejects.toThrow(/geometry fingerprint/);

    /* With one, it stores — and the fingerprint comes back with the drape, so the
       page can prove the rebuild rather than assume it. */
    await renders.recordRenderOutcome(w.ctx, {
      jobRef: job.jobRef,
      status: "completed",
      drape: drapeFor({ vertexCount: 12 }),
      actor: w.actor,
    });
    const read = await renders.readDrape(w.ctx, { jobRef: job.jobRef });
    expect(read.geometryIdentity).toBe("tee-4-piece-normal-fit-1.0");
    expect(read.vertexCount).toBe(12);
    /* And it names its OWN revision and carries the job's frozen setup, so the
       rebuild never uses whichever revision happens to be selected. */
    expect(read.patternRevisionRef).toBe(ready.revisionRef);
    expect(read.patternSet).toBeTruthy();
    expect(read.inputs.seams).toHaveLength(INPUTS.seams.length);
  });

  test("AN ABANDONED RENDER IS VISIBLE AND RECOVERABLE", async () => {
    const w = await world();
    const ready = await renderable(w);
    const job = (await withAdapter(() => renders.requestRender(w.ctx, {
      revisionId: ready.id, actor: w.actor,
    }))).render;

    /* Still beating: not abandoned, and clearing it is refused — stopping a
       colleague's running drape is a different act. */
    await renders.heartbeat(w.ctx, { jobRef: job.jobRef, runId: "lease-abc", actor: w.actor });
    expect((await renders.listAbandoned(w.ctx, { styleId: w.style._id })).abandoned).toHaveLength(0);
    await refuses(() => renders.recoverAbandoned(w.ctx, { jobRef: job.jobRef, actor: w.actor }),
      "RENDER_STILL_RUNNING");

    /* The tab closed. Ninety seconds of silence and nobody is working on it. */
    await RenderJob.updateOne({ jobRef: job.jobRef }, {
      $set: { "lease.expiresAt": new Date(Date.now() - 1000) },
    });

    const stuck = (await renders.listAbandoned(w.ctx, { styleId: w.style._id })).abandoned;
    expect(stuck).toHaveLength(1);
    expect(stuck[0].jobRef).toBe(job.jobRef);

    const out = await renders.recoverAbandoned(w.ctx, { jobRef: job.jobRef, actor: w.actor });
    expect(out.render.status).toBe(RENDER_STATUS.CANCELLED);
    /* Kept, not deleted: the history is the point, and it says WHY it ended. */
    const after = await RenderJob.findOne({ jobRef: job.jobRef }).lean();
    expect(after).toBeTruthy();
    expect(after.failure.code).toBe("DRAPE_ABANDONED");
    expect(after.recovery.recoveredAt).toBeTruthy();
    expect((await renders.listAbandoned(w.ctx, { styleId: w.style._id })).abandoned).toHaveLength(0);

    /* And the revision is free again, which is the whole point. */
    const retry = await withAdapter(() => renders.requestRender(w.ctx, {
      revisionId: ready.id, actor: w.actor,
    }));
    expect(retry.render.jobRef).not.toBe(job.jobRef);
  });

  test("a second browser cannot take over a lease the first is still holding", async () => {
    const w = await world();
    const ready = await renderable(w);
    const job = (await withAdapter(() => renders.requestRender(w.ctx, {
      revisionId: ready.id, actor: w.actor,
    }))).render;
    await renders.heartbeat(w.ctx, { jobRef: job.jobRef, runId: "lease-first", actor: w.actor });
    await refuses(() => renders.heartbeat(w.ctx, {
      jobRef: job.jobRef, runId: "lease-second", actor: w.actor,
    }), "RENDER_ALREADY_RUNNING");
    /* The first keeps it. */
    const mine = await renders.heartbeat(w.ctx, {
      jobRef: job.jobRef, runId: "lease-first", actor: w.actor,
    });
    expect(mine.holding).toBe(true);
    expect(mine.heartbeatMs).toBeGreaterThan(0);
  });
});

/* ═══ THE RECORD HAS TO BE ABLE TO HOLD WHAT THE PRODUCT WRITES ═══════════ */

describe("a drape is not lost to the length of its own explanation", () => {
  const { RenderJob } = require("../../models/CMS_Models/RnD/PatternRevision");

  /* The sentence `sewingLine.js` composes when no sewing line could be built.
     The one that lost a drape was 412 characters — it names the cut boundary,
     then the reason the derivation failed, then what sewing on the cut line does
     to a chest with two side seams and two armholes, then that every dimensional
     finding is withheld. It is authored by this system and never typed by
     anybody, and the field that stores it allowed 400. So EVERY drape of a
     pattern without a published sewing line failed to save, the browser was told
     "Something went wrong. Nothing was changed.", and twenty seconds of
     somebody's work went in the bin.

     The opening is quoted and the rest padded to that measured length, because
     what this test is about is the length a record must accept rather than the
     wording of a sentence that will be edited. */
  const OBSERVED_LENGTH = 412;
  const CUT_BOUNDARY_WHY = ("This drape is sewn on the CUT boundary. A sewing line could not be "
    + "constructed: the stated allowance could not be inset without self-intersection. Sewing on "
    + "the cut line changes where the pieces meet and how they hang — on a chest with two side "
    + "seams and two armholes a 10 mm allowance is of the order of 40 mm. The garment may be looked "
    + "at; every dimensional finding is withheld.").padEnd(OBSERVED_LENGTH, " ").slice(0, OBSERVED_LENGTH);

  test("the withheld-reason field accepts the longest reason the product composes", async () => {
    expect(CUT_BOUNDARY_WHY.length).toBe(OBSERVED_LENGTH);
    expect(OBSERVED_LENGTH).toBeGreaterThan(400);
    const path = RenderJob.schema.path("drape.withheld");
    const why = path.schema.path("why");
    expect(why.options.maxlength).toBeGreaterThanOrEqual(CUT_BOUNDARY_WHY.length);
  });

  test("a job carrying that reason validates", async () => {
    const job = new RenderJob({
      jobRef: "RJ-TEST",
      styleId: new mongoose.Types.ObjectId(),
      status: "completed",
      drape: {
        vertexCount: 3,
        sewingLineSource: "cut-boundary",
        geometryIdentity: "abc",
        authoritative: false,
        withheld: [{ finding: "chest", why: CUT_BOUNDARY_WHY }],
      },
    });
    /* Only the paths this test is about; a missing unrelated required field
       would be a different complaint and would hide this one. */
    const err = await job.validate().then(() => null, (e) => e);
    const complaints = err ? Object.keys(err.errors || {}) : [];
    expect(complaints.filter((k) => k.startsWith("drape.withheld"))).toEqual([]);
  });
});
